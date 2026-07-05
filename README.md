# ioBroker AdvanSol Optimizer Adapter

ioBroker adapter for AdvanSol DCON-WIFI / MRO/MR optimizers connected through a TCP-to-RS485 bridge, for example a Waveshare ETH-to-RS485 adapter.

The adapter is based on the original ioBroker JavaScript script `Advinsol Optimierer2` and moves the logic into a real ioBroker adapter namespace.

![System overview](docs/images/system-overview.svg)

## Deutsch

### Funktion

Der Adapter verbindet sich per TCP mit einer RS485-Bridge und spricht darueber mit dem AdvanSol Controller und den angeschlossenen Optimierern. Beim Start wird die Controller-Seriennummer gelesen, danach wird die Modulliste abgefragt. Fuer jedes gefundene Modul werden automatisch ioBroker-Datenpunkte angelegt.

Der Adapter kann:

- TCP-Verbindung zur RS485-Bridge aufbauen.
- Controller-Seriennummer lesen.
- Angeschlossene Optimierer automatisch erkennen.
- Modulwerte zyklisch abfragen.
- MOS je Optimierer ueber `module_X.switch` schalten.
- Polling in einem einstellbaren Nachtfenster aussetzen.
- Verbindungsstatus und Nachtmodus als Datenpunkte bereitstellen.

### Typischer Aufbau

1. ioBroker laeuft im lokalen Netzwerk.
2. Eine TCP-RS485-Bridge ist per LAN/WLAN erreichbar.
3. Die RS485-Seite der Bridge ist mit dem AdvanSol Controller verbunden.
4. Der Controller kommuniziert mit den Optimierer-Modulen.

Empfohlene Bridge-Einstellung:

- Modus: TCP Server
- Port: passend zur Adaptereinstellung, Standard `502`
- Serielle Schnittstelle: wie vom AdvanSol Controller/RS485-Bus benoetigt
- RS485 A/B korrekt anschliessen
- Nur ein aktiver Master auf dem RS485-Bus

### Adapter-Einstellungen

![Adapter settings](docs/images/adapter-settings.svg)

| Einstellung | Bedeutung | Standard |
| --- | --- | --- |
| `Host` | IP-Adresse oder Hostname der TCP-RS485-Bridge | leer |
| `TCP port` | TCP-Port der Bridge | `502` |
| `Polling interval` | Zeit zwischen zwei Polling-Zyklen in Millisekunden | `10000` |
| `Request timeout` | Maximale Wartezeit auf eine Antwort | `5000` |
| `Switch retries` | Anzahl wiederholter MOS-Schaltbefehle | `3` |
| `Switch retry delay` | Pause zwischen Schaltversuchen | `4100` |
| `Night mode starts` | Stunde, ab der nicht mehr gepollt wird | `22` |
| `Night mode ends` | Stunde, ab der Polling wieder startet | `5` |

Das Nachtfenster verhindert unnoetige Fehlermeldungen, wenn die Optimierer nachts oder ohne PV-Spannung nicht antworten.

### Datenpunkte

![Object tree](docs/images/object-tree.svg)

Allgemeine Datenpunkte:

| Datenpunkt | Bedeutung |
| --- | --- |
| `info.connection` | Verbindung zur TCP-RS485-Bridge |
| `connection` | zusaetzlicher Verbindungsstatus |
| `controller.sn` | Seriennummer des Controllers |
| `module_count` | Anzahl erkannter Optimierer |
| `last_poll` | Zeitpunkt der letzten erfolgreichen Polling-Runde |
| `night_mode` | Adapter hat Nachtmodus erkannt |

Pro Optimierer wird ein Kanal `module_1`, `module_2`, `module_3` usw. angelegt.

| Datenpunkt | Bedeutung | Einheit |
| --- | --- | --- |
| `module_X.sn` | Seriennummer des Optimierers |  |
| `module_X.switch` | MOS Ein/Aus, beschreibbar |  |
| `module_X.mos` | MOS Status, `0` aus und `1` ein |  |
| `module_X.software` | Softwareversion |  |
| `module_X.hardware` | Hardwareversion |  |
| `module_X.output_voltage` | Ausgangsspannung | V |
| `module_X.output_current` | Ausgangsstrom | A |
| `module_X.input_voltage` | Eingangsspannung | V |
| `module_X.input_current` | Eingangsstrom | A |
| `module_X.power` | Leistung | W |
| `module_X.energy` | Gesamtertrag | kWh |
| `module_X.temperature` | Temperatur | degC |
| `module_X.raw` | rohe Antwort als Hex-String |  |
| `module_X.last_update` | letzte Aktualisierung des Moduls |  |

### Schalten der Optimierer

Der Datenpunkt `module_X.switch` ist beschreibbar. Wird er auf `true` gesetzt, sendet der Adapter einen MOS-Ein-Befehl fuer die Seriennummer dieses Moduls. Wird er auf `false` gesetzt, sendet der Adapter den MOS-Aus-Befehl.

Der Adapter wiederholt den Schaltbefehl entsprechend `Switch retries`. Zwischen den Versuchen wartet er `Switch retry delay`. Das ist bewusst so umgesetzt, weil RS485/TCP-Wandler und Optimierer nicht immer jede Telegrammfolge sofort bestaetigen.

### Installation

Aus einem lokalen Paket:

```bash
iobroker url /path/to/iobroker.advansol-optimizer-0.1.2.tgz
```

Aus einem Projektordner:

```bash
iobroker url /root/iobroker.advansol-optimizer
```

Nach der Installation eine Instanz anlegen, Host/Port der Bridge eintragen und die Instanz starten.

### Fehlersuche

- Keine Verbindung: IP-Adresse, Port und TCP-Server-Modus der Bridge pruefen.
- `TCP connect timeout`: Bridge nicht erreichbar oder falscher Port.
- Keine Module erkannt: RS485 A/B pruefen, Controller eingeschaltet, PV-Seite versorgt.
- Tagsueber keine Antworten: RS485-Parameter und Verdrahtung pruefen.
- Nachts keine Antworten: normal, wenn die Optimierer ohne PV-Spannung schlafen. Nachtfenster passend einstellen.
- Schalten funktioniert nicht: Seriennummer muss gelesen sein, Modul muss antworten, `Switch retries` ggf. erhoehen.
- Mehrere Systeme am Bus: sicherstellen, dass nicht mehrere Master gleichzeitig Telegramme senden.

## English

### Purpose

The adapter connects to a TCP-to-RS485 bridge and communicates with the AdvanSol controller and connected optimizer modules. On startup it reads the controller serial number and then discovers the module list. For every discovered module, ioBroker states are created automatically.

The adapter can:

- Connect to a TCP RS485 bridge.
- Read the controller serial number.
- Discover connected optimizer modules.
- Poll module values cyclically.
- Switch each optimizer MOS through `module_X.switch`.
- Skip polling during a configurable night window.
- Expose connection state and night mode states.

### Typical Setup

1. ioBroker runs in the local network.
2. A TCP-RS485 bridge is reachable via LAN/Wi-Fi.
3. The RS485 side of the bridge is connected to the AdvanSol controller.
4. The controller communicates with the optimizer modules.

Recommended bridge configuration:

- Mode: TCP server
- Port: same as configured in the adapter, default `502`
- Serial settings: matching the AdvanSol controller/RS485 bus
- RS485 A/B connected correctly
- Only one active master on the RS485 bus

### Adapter Settings

| Setting | Meaning | Default |
| --- | --- | --- |
| `Host` | IP address or host name of the TCP-RS485 bridge | empty |
| `TCP port` | TCP port of the bridge | `502` |
| `Polling interval` | Time between polling cycles in milliseconds | `10000` |
| `Request timeout` | Maximum wait time for a response | `5000` |
| `Switch retries` | Number of repeated MOS switch commands | `3` |
| `Switch retry delay` | Delay between switch attempts | `4100` |
| `Night mode starts` | Hour where polling is skipped | `22` |
| `Night mode ends` | Hour where polling resumes | `5` |

The night window avoids unnecessary errors when optimizers do not respond at night or without PV-side voltage.

### States

General states:

| State | Meaning |
| --- | --- |
| `info.connection` | Connection to the TCP-RS485 bridge |
| `connection` | Additional connection state |
| `controller.sn` | Controller serial number |
| `module_count` | Number of discovered optimizers |
| `last_poll` | Time of the last successful poll cycle |
| `night_mode` | Adapter detected night mode |

Each optimizer gets a channel named `module_1`, `module_2`, `module_3` and so on.

| State | Meaning | Unit |
| --- | --- | --- |
| `module_X.sn` | Optimizer serial number |  |
| `module_X.switch` | MOS on/off, writable |  |
| `module_X.mos` | MOS status, `0` off and `1` on |  |
| `module_X.software` | Software version |  |
| `module_X.hardware` | Hardware version |  |
| `module_X.output_voltage` | Output voltage | V |
| `module_X.output_current` | Output current | A |
| `module_X.input_voltage` | Input voltage | V |
| `module_X.input_current` | Input current | A |
| `module_X.power` | Power | W |
| `module_X.energy` | Total energy | kWh |
| `module_X.temperature` | Temperature | degC |
| `module_X.raw` | Raw response as hex string |  |
| `module_X.last_update` | Last module update |  |

### Switching Optimizers

The state `module_X.switch` is writable. Setting it to `true` sends the MOS-on command for the module serial number. Setting it to `false` sends the MOS-off command.

The adapter repeats the command according to `Switch retries` and waits `Switch retry delay` between attempts. This is intentional because TCP-RS485 converters and optimizer modules may not acknowledge every command immediately.

### Installation

From a local package:

```bash
iobroker url /path/to/iobroker.advansol-optimizer-0.1.2.tgz
```

From a project folder:

```bash
iobroker url /root/iobroker.advansol-optimizer
```

After installation, create an instance, enter the bridge host/port and start the instance.

### Troubleshooting

- No connection: check IP address, port and TCP server mode of the bridge.
- `TCP connect timeout`: bridge is not reachable or the port is wrong.
- No modules discovered: check RS485 A/B, controller power and PV-side supply.
- No daytime responses: check RS485 parameters and wiring.
- No nighttime responses: usually normal if optimizers sleep without PV voltage. Adjust the night window.
- Switching does not work: serial number must be known, module must respond, increase `Switch retries` if needed.
- Multiple systems on the bus: make sure there is not more than one active master sending frames.

## Changelog

### 0.1.2

- Updated package metadata for ioBroker adapter checker compatibility.
- Added repository, testing, license information, tier and extended translations.

### 0.1.1

- Added adapter icon and localized admin configuration labels.

### 0.1.0

- Initial adapter version based on the existing ioBroker JavaScript optimizer script.
