"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Load the real adapter with only the ioBroker runtime replaced.
class Adapter {
    constructor() {
        this.config = {};
        this.on = () => {};
        this.log = { info() {}, warn() {} };
    }
}
const context = { Buffer, require: name => name === "@iobroker/adapter-core" ? { Adapter } : require(name), module: { exports: {} } };
vm.runInNewContext(readFileSync(path.join(__dirname, "../../main.js"), "utf8"), context);
const controllerSn = "40332F60047A";
function adapter() {
    const a = context.module.exports();
    a.values = {};
    a.setVal = async (id, value) => { a.values[id] = value; };
    return a;
}
function fixture(page) {
    return Buffer.from(readFileSync(path.join(__dirname, `fixtures/device-list-page${page}.hex`), "utf8").trim(), "hex");
}
function checksum(a, frame) {
    frame.writeUInt16LE(a.crc16(frame.subarray(0, 254)), 254);
    return frame;
}
function pageFrame(a, page, pages, total, entries) {
    const frame = Buffer.alloc(256, 0xff);
    frame.set([1, 0x42, pages, page]);
    frame.writeUInt16BE(total, 4);
    frame.writeUInt16BE(entries.length, 6);
    frame.writeUInt16BE(entries.length * 10, 8);
    entries.forEach((index, i) => {
        Buffer.from(index.toString(16).padStart(12, "0"), "hex").copy(frame, 10 + i * 10);
        frame.writeUInt16BE(0x0101, 16 + i * 10);
        frame.writeUInt16BE(index, 18 + i * 10);
    });
    return checksum(a, frame);
}

test("reads both captured controller pages and preserves addresses 1 through 15", async () => {
    const a = adapter();
    const pages = [];
    a.request = async payload => {
        pages.push(payload[2]);
        assert.equal(Buffer.from(payload.slice(3)).toString("hex").toUpperCase(), controllerSn);
        return fixture(payload[2]);
    };
    const modules = await a.readDeviceList(controllerSn);
    assert.deepEqual(pages, [1, 2]);
    assert.equal(modules.length, 15);
    assert.equal(a.values.module_count, 15);
    assert.deepEqual(Array.from(modules, m => m.index), Array.from({ length: 15 }, (_, i) => i + 1));
    assert.equal(modules[10].sn, "33332E8005AA");
    assert.equal(modules[14].sn, "33332E804CAA");
});

test("follows more than two pages without a hardcoded device limit", async () => {
    const a = adapter();
    const pages = [];
    a.request = async payload => {
        const page = payload[2];
        pages.push(page);
        return pageFrame(a, page, 4, 31, Array.from({ length: page === 4 ? 1 : 10 }, (_, i) => (page - 1) * 10 + i + 1));
    };
    const modules = await a.readDeviceList(controllerSn);
    assert.deepEqual(pages, [1, 2, 3, 4]);
    assert.equal(modules.length, 31);
    assert.equal(modules[30].index, 31);
});

test("supports single-page and empty device lists", async () => {
    for (const entries of [[7], []]) {
        const a = adapter();
        a.request = async () => pageFrame(a, 1, 1, entries.length, entries);
        const modules = await a.readDeviceList(controllerSn);
        assert.equal(modules.length, entries.length);
        if (entries.length) assert.equal(modules[0].index, 7);
    }
});

for (const failure of ["timeout", "crc", "truncated", "wrong page", "changed total", "changed pages", "oversized count", "wrong length", "duplicate address", "duplicate serial", "missing device"]) {
    test(`rejects ${failure} without publishing a partial count`, async () => {
        const a = adapter();
        a.values.module_count = 10;
        a.request = async payload => {
            if (payload[2] === 1) return fixture(1);
            if (failure === "timeout") throw new Error("timeout");
            const frame = fixture(2);
            if (failure === "crc") { frame[20] ^= 1; return frame; }
            if (failure === "truncated") return frame.subarray(0, 80);
            if (failure === "wrong page") frame[3] = 1;
            if (failure === "changed total") frame.writeUInt16BE(16, 4);
            if (failure === "changed pages") frame[2] = 3;
            if (failure === "oversized count") frame.writeUInt16BE(25, 6);
            if (failure === "wrong length") frame.writeUInt16BE(60, 8);
            if (failure === "duplicate address") frame.writeUInt16BE(1, 18);
            if (failure === "duplicate serial") fixture(1).copy(frame, 10, 10, 16);
            if (failure === "missing device") { frame.writeUInt16BE(4, 6); frame.writeUInt16BE(40, 8); }
            return checksum(a, frame);
        };
        await assert.rejects(a.readDeviceList(controllerSn));
        assert.equal(a.values.module_count, 10);
    });
}

test("measurement requests use the full device address", async () => {
    const a = adapter();
    let sent;
    a.request = async payload => { sent = payload; const frame = Buffer.alloc(256); frame.set([1, 0x43]); return checksum(a, frame); };
    a.parseModuleResponse = async () => {};
    await a.readModule(258);
    assert.deepEqual(Array.from(sent), [0, 0x43, 1, 2, 0, 0x17]);
});

test("request queue recovers after a failed exchange", async () => {
    const a = adapter();
    a.reconnectIfNeeded = async () => {};
    let attempts = 0;
    a.doRequest = async () => { if (++attempts === 1) throw new Error("timeout"); return fixture(1); };
    await assert.rejects(a.request([0]));
    assert.equal((await a.request([0])).length, 256);
    assert.equal(attempts, 2);
});

function pollAdapter() {
    const a = adapter();
    a.initialized = true;
    a.modules = [{ index: 1, sn: "000000000001" }];
    a.isNightHour = () => false;
    a.wait = async () => {};
    a.readControllerSn = async () => controllerSn;
    a.initStatesForModule = async () => {};
    a.registerSwitchHandler = async () => {};
    a.reads = [];
    a.readModule = async index => a.reads.push(index);
    return a;
}

test("periodic discovery adds devices without restarting", async () => {
    const a = pollAdapter();
    a.request = async payload => fixture(payload[2]);
    await a.poll();
    assert.equal(a.modules.length, 15);
    assert.deepEqual(a.reads, Array.from({ length: 15 }, (_, i) => i + 1));
    a.request = async () => { throw new Error("should not rescan every poll"); };
    await a.poll();
    assert.equal(a.reads.length, 30);
});

test("failed periodic discovery keeps polling the previous devices", async () => {
    const a = pollAdapter();
    a.request = async () => { throw new Error("timeout"); };
    await a.poll();
    assert.equal(a.modules.length, 1);
    assert.deepEqual(a.reads, [1]);
    assert.ok(a.lastDiscoveryAttempt > Date.now() - 1000);
    assert.equal(a.polling, false);
});

for (const failure of ["wrong serial", "bad checksum"]) {
    test(`rejects a measurement with ${failure} before updating any states`, async () => {
        const a = adapter();
        a.modules = [{ index: 1, sn: "33332E80191A" }];
        const frame = Buffer.alloc(256);
        frame.set([1, 0x43, 0x2e]);
        Buffer.from(failure === "wrong serial" ? "33332E800FEA" : "33332E80191A", "hex").copy(frame, 3);
        checksum(a, frame);
        if (failure === "bad checksum") frame[25] ^= 1;
        a.request = async () => frame;
        a.parseModuleResponse = async () => { assert.fail("invalid response must not update states"); };
        await assert.rejects(a.readModule(1), /invalid or mismatched/);
    });
}
