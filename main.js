"use strict";

const net = require("net");
const utils = require("@iobroker/adapter-core");

class AdvansolOptimizer extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "advansol-optimizer",
        });

        this.socket = null;
        this.connected = false;
        this.requestQueue = Promise.resolve();
        this.modules = [];
        this.moduleErrorCount = {};
        this.nightMode = false;
        this.nightCheckCounter = 0;
        this.initialized = false;
        this.polling = false;
        this.pollTimer = null;
        this.switchSubscriptions = new Set();

        this.nightFailLimit = 5;
        this.nightCheckEvery = 180;
        this.moduleReadDelayMs = 900;
        this.finishDelayMs = 350;

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    get cfg() {
        return {
            host: String(this.config.host || "").trim(),
            tcpPort: Number(this.config.tcpPort || 502),
            pollMs: Number(this.config.pollMs || 10000),
            requestTimeoutMs: Number(this.config.requestTimeoutMs || 5000),
            switchRetries: Number(this.config.switchRetries || 3),
            switchRetryDelayMs: Number(this.config.switchRetryDelayMs || 4100),
            nightStart: Number(this.config.nightStart ?? 22),
            nightEnd: Number(this.config.nightEnd ?? 5),
        };
    }

    async onReady() {
        await this.initBaseStates();
        await this.setStateAsync("info.connection", false, true);

        try {
            if (!this.cfg.host) {
                this.log.warn("No TCP RS485 bridge host configured. Please enter the bridge IP address or host name in the adapter settings.");
                return;
            }

            await this.connectTcp();
            await this.poll();
            this.pollTimer = this.setInterval(() => void this.poll(), this.cfg.pollMs);
        } catch (error) {
            this.log.error(`AdvanSol start error: ${error.message}`);
        }
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) {
                this.clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            if (this.socket) {
                this.socket.destroy();
                this.socket = null;
            }
            callback();
        } catch {
            callback();
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }

        const ownPrefix = `${this.namespace}.`;
        if (!id.startsWith(ownPrefix)) {
            return;
        }

        const rel = id.slice(ownPrefix.length);
        const match = rel.match(/^module_(\d+)\.switch$/);
        if (!match) {
            return;
        }

        const index = Number(match[1]);
        try {
            const snState = await this.getStateAsync(`module_${index}.sn`);
            const sn = snState && snState.val;
            if (!sn) {
                this.log.warn(`No serial number found for module ${index}`);
                return;
            }

            await this.switchModule(String(sn), state.val === true);
        } catch (error) {
            this.log.error(`Switching module ${index} failed: ${error.message}`);
        }
    }

    crc16(buf) {
        let crc = 0xffff;
        for (const b of buf) {
            crc ^= b;
            for (let i = 0; i < 8; i++) {
                crc = (crc & 1) ? (crc >> 1) ^ 0xa001 : crc >> 1;
            }
        }
        return crc & 0xffff;
    }

    makeFrame(payload) {
        const frame = Buffer.alloc(256, 0xff);
        Buffer.from(payload).copy(frame, 0);
        const crc = this.crc16(frame.subarray(0, 254));
        frame[254] = crc & 0xff;
        frame[255] = (crc >> 8) & 0xff;
        return frame;
    }

    hex(buf) {
        return Buffer.from(buf).toString("hex").toUpperCase();
    }

    u16(buf, pos) {
        return buf.readUInt16BE(pos);
    }

    i16(buf, pos) {
        return buf.readInt16BE(pos);
    }

    u32(buf, pos) {
        return buf.readUInt32BE(pos);
    }

    wait(ms) {
        return new Promise(resolve => this.setTimeout(resolve, ms));
    }

    async ensureState(id, name, role, type, unit = "", write = false) {
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: {
                name,
                role,
                type,
                unit,
                read: true,
                write,
            },
            native: {},
        });
    }

    async ensureChannel(id, name) {
        await this.setObjectNotExistsAsync(id, {
            type: "channel",
            common: { name },
            native: {},
        });
    }

    async setVal(id, val) {
        await this.setStateAsync(id, val, true);
    }

    async initBaseStates() {
        await this.ensureChannel("info", "Information");
        await this.ensureState("info.connection", "Connection", "indicator.connected", "boolean");
        await this.ensureChannel("controller", "Controller");
        await this.ensureState("controller.sn", "Controller Seriennummer", "text", "string");
        await this.ensureState("module_count", "Anzahl Optimierer", "value", "number");
        await this.ensureState("last_poll", "Letzter Poll", "date", "string");
        await this.ensureState("connection", "Verbindungsstatus", "indicator.connected", "boolean");
        await this.ensureState("night_mode", "Nachtmodus", "indicator", "boolean");
    }

    async initStatesForModule(index) {
        const base = `module_${index}`;
        await this.ensureChannel(base, `Optimierer ${index}`);
        await this.ensureState(`${base}.sn`, "Seriennummer", "text", "string");
        await this.ensureState(`${base}.switch`, "MOS Ein/Aus", "switch", "boolean", "", true);
        await this.ensureState(`${base}.mos`, "MOS Status 0=aus 1=ein", "value", "number");
        await this.ensureState(`${base}.software`, "Softwareversion", "text", "string");
        await this.ensureState(`${base}.hardware`, "Hardwareversion", "text", "string");
        await this.ensureState(`${base}.output_voltage`, "Spannung", "value.voltage", "number", "V");
        await this.ensureState(`${base}.output_current`, "Strom", "value.current", "number", "A");
        await this.ensureState(`${base}.temperature`, "Temperatur", "value.temperature", "number", "degC");
        await this.ensureState(`${base}.power`, "Leistung", "value.power", "number", "W");
        await this.ensureState(`${base}.energy`, "Gesamtertrag", "value.energy", "number", "kWh");
        await this.ensureState(`${base}.input_voltage`, "Eingangsspannung", "value.voltage", "number", "V");
        await this.ensureState(`${base}.input_current`, "Eingangsstrom", "value.current", "number", "A");
        await this.ensureState(`${base}.raw`, "Raw Antwort", "text", "string");
        await this.ensureState(`${base}.last_update`, "Letzte Aktualisierung", "date", "string");
    }

    connectTcp() {
        const cfg = this.cfg;
        return new Promise((resolve, reject) => {
            this.socket = new net.Socket();
            this.socket.setNoDelay(true);

            const connectTimer = this.setTimeout(() => {
                reject(new Error(`TCP connect timeout to ${cfg.host}:${cfg.tcpPort}`));
                try {
                    this.socket.destroy();
                } catch {
                    // ignore cleanup errors
                }
            }, cfg.requestTimeoutMs);

            this.socket.connect(cfg.tcpPort, cfg.host, () => {
                this.clearTimeout(connectTimer);
                this.connected = true;
                void this.setStateAsync("info.connection", true, true);
                void this.setVal("connection", true);
                this.log.info(`AdvanSol connected to ${cfg.host}:${cfg.tcpPort}`);
                resolve();
            });

            this.socket.on("error", err => {
                this.connected = false;
                void this.setStateAsync("info.connection", false, true);
                void this.setVal("connection", false);
                this.log.warn(`AdvanSol TCP error: ${err.message}`);
            });

            this.socket.on("close", () => {
                this.connected = false;
                void this.setStateAsync("info.connection", false, true);
                void this.setVal("connection", false);
                this.log.warn("AdvanSol TCP connection closed");
            });

            this.socket.setTimeout(30000);
            this.socket.on("timeout", () => {
                this.log.warn("AdvanSol TCP timeout, reconnecting");
                try {
                    this.socket.destroy();
                } catch {
                    // ignore cleanup errors
                }
            });
        });
    }

    async reconnectIfNeeded() {
        if (this.connected && this.socket && !this.socket.destroyed) {
            return;
        }

        try {
            if (this.socket) {
                this.socket.destroy();
            }
        } catch {
            // ignore cleanup errors
        }

        await this.wait(1000);
        await this.connectTcp();
    }

    doRequest(payload, timeout = this.cfg.requestTimeoutMs) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected || this.socket.destroyed) {
                reject(new Error("TCP not connected"));
                return;
            }

            const chunks = [];
            let finishTimer = null;
            let hardTimer = null;
            let finished = false;

            const cleanup = () => {
                if (finishTimer) this.clearTimeout(finishTimer);
                if (hardTimer) this.clearTimeout(hardTimer);
                this.socket.off("data", onData);
            };

            const finish = () => {
                if (finished) return;
                finished = true;
                cleanup();
                resolve(Buffer.concat(chunks));
            };

            const onData = data => {
                chunks.push(data);
                const total = Buffer.concat(chunks);
                if (total.length >= 256) {
                    finish();
                    return;
                }
                if (finishTimer) this.clearTimeout(finishTimer);
                finishTimer = this.setTimeout(finish, this.finishDelayMs);
            };

            this.socket.on("data", onData);
            const frame = this.makeFrame(payload);

            this.socket.write(frame, err => {
                if (err) {
                    cleanup();
                    reject(err);
                    return;
                }
                hardTimer = this.setTimeout(finish, timeout);
            });
        });
    }

    request(payload, timeout = this.cfg.requestTimeoutMs) {
        this.requestQueue = this.requestQueue
            .then(async () => {
                await this.reconnectIfNeeded();
                return this.doRequest(payload, timeout);
            })
            .catch(async err => {
                this.log.warn(`Request error: ${err.message}`);
                throw err;
            });
        return this.requestQueue;
    }

    async readControllerSn() {
        const res = await this.request([0x00, 0x03, 0xff, 0xe7, 0x00, 0x03]);
        if (res.length >= 9 && res[0] === 0x01 && res[1] === 0x03 && res[2] === 0x06) {
            const sn = this.hex(res.subarray(3, 9));
            await this.setVal("controller.sn", sn);
            return sn;
        }
        throw new Error(`Invalid controller SN response: ${this.hex(res)}`);
    }

    async readDeviceList(controllerSn) {
        const snBytes = Buffer.from(controllerSn, "hex");
        const res = await this.request([0x00, 0x42, 0x01, ...snBytes], 2500);

        if (!(res.length > 20 && res[0] === 0x01 && res[1] === 0x42)) {
            throw new Error(`Invalid device list response: ${this.hex(res)}`);
        }

        const count = this.u16(res, 6);
        const modules = [];

        for (let i = 0; i < count; i++) {
            const pos = 10 + i * 10;
            if (pos + 6 > res.length) break;
            const sn = this.hex(res.subarray(pos, pos + 6));
            if (sn !== "FFFFFFFFFFFF" && sn.length === 12) {
                modules.push({ index: i + 1, sn });
            }
        }

        await this.setVal("module_count", modules.length);
        return modules;
    }

    async parseModuleResponse(index, res) {
        if (!(res.length > 40 && res[0] === 0x01 && res[1] === 0x43)) {
            throw new Error(`Module ${index}: invalid response: ${this.hex(res)}`);
        }

        const base = `module_${index}`;
        const sn = this.hex(res.subarray(3, 9));
        const mos = this.u16(res, 9);
        const sw = [...res.subarray(11, 15)].map(x => x.toString(16).padStart(2, "0").toUpperCase()).join(".");
        const hw = [...res.subarray(15, 19)].map(x => x.toString(16).padStart(2, "0").toUpperCase()).join(".");

        await this.setVal(`${base}.sn`, sn);
        await this.setVal(`${base}.mos`, mos);
        await this.setVal(`${base}.switch`, mos === 1);
        await this.setVal(`${base}.software`, sw);
        await this.setVal(`${base}.hardware`, hw);
        await this.setVal(`${base}.output_voltage`, this.i16(res, 19) / 100);
        await this.setVal(`${base}.output_current`, this.i16(res, 21) / 100);
        await this.setVal(`${base}.temperature`, this.u16(res, 23) - 100);
        await this.setVal(`${base}.power`, this.i16(res, 25));
        await this.setVal(`${base}.energy`, this.u32(res, 27) / 100);
        await this.setVal(`${base}.input_voltage`, this.i16(res, 31) / 100);
        await this.setVal(`${base}.input_current`, this.i16(res, 33) / 100);
        await this.setVal(`${base}.raw`, this.hex(res));
        await this.setVal(`${base}.last_update`, new Date().toISOString());
    }

    async readModule(index) {
        const res = await this.request([0x00, 0x43, 0x00, index, 0x00, 0x17], 2500);
        await this.parseModuleResponse(index, res);
    }

    async switchModule(sn, targetOn) {
        const cfg = this.cfg;
        const snBytes = Buffer.from(sn, "hex");
        if (snBytes.length !== 6) {
            throw new Error(`Invalid serial number: ${sn}`);
        }

        const payload = targetOn
            ? [0x00, 0x05, 0xff, 0xef, 0xff, 0x00, ...snBytes]
            : [0x00, 0x05, 0xff, 0xef, 0x00, 0x00, ...snBytes];

        this.log.info(`Switch optimizer ${sn} -> ${targetOn ? "ON" : "OFF"}`);
        for (let i = 1; i <= cfg.switchRetries; i++) {
            try {
                const res = await this.request(payload, 1200);
                this.log.info(`Switch command try ${i}/${cfg.switchRetries}, response: ${this.hex(res)}`);
            } catch (error) {
                this.log.warn(`Switch command try ${i}/${cfg.switchRetries} failed: ${error.message}`);
            }

            if (i < cfg.switchRetries) {
                await this.wait(cfg.switchRetryDelayMs);
            }
        }
    }

    async discover() {
        const controllerSn = await this.readControllerSn();
        this.log.info(`AdvanSol controller SN: ${controllerSn}`);

        this.modules = await this.readDeviceList(controllerSn);
        this.log.info(`Found optimizers: ${this.modules.map(m => `${m.index}:${m.sn}`).join(", ")}`);

        for (const m of this.modules) {
            await this.initStatesForModule(m.index);
            await this.setVal(`module_${m.index}.sn`, m.sn);
            await this.registerSwitchHandler(m.index);
        }

        this.initialized = true;
    }

    async registerSwitchHandler(index) {
        const stateId = `module_${index}.switch`;
        if (this.switchSubscriptions.has(stateId)) {
            return;
        }
        this.switchSubscriptions.add(stateId);
        await this.subscribeStatesAsync(stateId);
    }

    isNightHour(hour) {
        const { nightStart, nightEnd } = this.cfg;
        return nightStart <= nightEnd
            ? hour >= nightStart && hour < nightEnd
            : hour >= nightStart || hour < nightEnd;
    }

    async poll() {
        if (this.isNightHour(new Date().getHours())) {
            return;
        }
        if (this.polling) {
            return;
        }

        this.polling = true;
        try {
            if (!this.initialized || this.modules.length === 0) {
                await this.discover();
            }

            if (this.nightMode) {
                this.nightCheckCounter++;
                if (this.nightCheckCounter < this.nightCheckEvery) {
                    return;
                }

                this.nightCheckCounter = 0;
                try {
                    await this.readModule(1);
                    this.nightMode = false;
                    await this.setVal("night_mode", false);
                    this.log.info("AdvanSol night mode ended, optimizers respond again");
                } catch {
                    return;
                }
            }

            let successCount = 0;
            let failCount = 0;

            for (const m of this.modules) {
                try {
                    await this.readModule(m.index);
                    this.moduleErrorCount[m.index] = 0;
                    successCount++;
                } catch {
                    this.moduleErrorCount[m.index] = (this.moduleErrorCount[m.index] || 0) + 1;
                    failCount++;

                    if (!this.nightMode && this.moduleErrorCount[m.index] === 5) {
                        this.log.warn(`Module ${m.index} has had no valid response for 5 tries`);
                    }
                }

                await this.wait(this.moduleReadDelayMs);
            }

            if (failCount >= this.nightFailLimit && successCount === 0) {
                this.nightMode = true;
                await this.setVal("night_mode", true);
                this.log.info("AdvanSol night mode active: optimizers do not respond");
            }

            await this.setVal("last_poll", new Date().toISOString());
        } catch (error) {
            this.log.warn(`AdvanSol poll error: ${error.message}`);
        } finally {
            this.polling = false;
        }
    }
}

if (require.main !== module) {
    module.exports = options => new AdvansolOptimizer(options);
} else {
    new AdvansolOptimizer();
}
