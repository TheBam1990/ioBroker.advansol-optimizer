# ioBroker AdvanSol Optimizer Adapter

ioBroker adapter for AdvanSol DCON-WIFI / MRO/MR optimizers connected through a Waveshare ETH-to-RS485 bridge in TCP server mode.

This adapter was built from the existing ioBroker JavaScript script `Advinsol Optimierer2`.

## Features

- Connects to the TCP RS485 bridge.
- Reads controller serial number.
- Discovers optimizer modules.
- Polls module values:
  - serial number
  - MOS state
  - software and hardware version
  - output voltage/current
  - temperature
  - power
  - total energy
  - input voltage/current
  - raw response
- Provides writable `module_X.switch` states for switching optimizer MOS on/off.
- Skips polling during the configured night window.

## Configuration

- `Host`: IP address of the TCP RS485 bridge.
- `TCP_PORT`: TCP port of the bridge.
- `POLL_MS`: polling interval in milliseconds.
- `Request_timeout`: request timeout in milliseconds.
- `Switch Retries`: number of repeated switch commands.
- `Switch_Retry_delay_ms`: delay between switch retries.
- `Night_start`: first hour where polling is skipped.
- `Night_end`: first hour where polling resumes.

## Install from GitHub

```bash
iobroker url https://github.com/your-name/ioBroker.advansol-optimizer
```

For local testing from this folder:

```bash
iobroker url /root/iobroker.advansol-optimizer
```

## Notes

The adapter runs in its own namespace, for example `advansol-optimizer.0.module_1.power`. The original script used `javascript.0.advansol.*`.
