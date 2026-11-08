# Mobile and offline

## What is delivered

A responsive web client that installs to a phone home screen ("Add to Home Screen") and an offline
synchronisation API. The same deployment serves desk terminals, tablets and phones; there is no
second codebase and no app-store dependency.

Covered mobile workflows:

| Workflow | How |
| --- | --- |
| Waiter order taking | Restaurant → Orders & POS; responsive layout, large tap targets |
| Kitchen ticket progression | Restaurant → Kitchen display |
| Bar orders | Bar → Orders |
| Housekeeping task completion | Hotel → Housekeeping (online); offline via sync API |
| Maintenance request | Online form; offline via sync API |
| Owner snapshot | Dashboard and reports |

## Offline design

The client is intentionally conservative: it performs **online** operations by default and exposes a
command queue for the two workflows that must survive a dead spot — housekeeping completion and
maintenance requests.

### Command contract

```http
POST /api/v1/sync/devices
{ "deviceId": "housekeeping-tablet-01", "platform": "pwa", "appVersion": "0.1.0" }
```

```http
POST /api/v1/sync/commands
{
  "deviceId": "housekeeping-tablet-01",
  "commandId": "8f2c1a6e-...",
  "commandType": "housekeeping.task.complete",
  "payload": {
    "taskId": "…",
    "notes": "Room cleaned, minibar restocked",
    "checklist": [{ "itemId": "…", "done": true }],
    "appVersion": "0.1.0"
  }
}
```

- `commandId` is generated on the device and is the idempotency key. Replaying the same command
  returns the stored result with `status: "duplicate"` and does not re-apply it.
- If the server already completed the task, the command is stored as `conflict` and a
  `mobile.sync_conflicts` row is created with `resolution: 'pending'`. Nothing is overwritten.
- Conflicts are reviewed with `GET /api/v1/sync/conflicts` and closed with
  `POST /api/v1/sync/conflicts/:id/resolve` (`client_wins`, `server_wins`, `merged`, `discarded`).
- Commands require `platform.sync.execute`; a cashier without that permission receives `403`.
- Supported command types today: `housekeeping.task.complete` and `maintenance.request.create`.
  Unknown types are rejected and recorded, not silently dropped.

### Offline boundaries

Not available offline: payments, folio settlement, room allocation, check-in, night audit, licence
changes. These require a live server because they depend on database-level concurrency and financial
constraints. The client must show a clear "offline — queued" state rather than pretending success.

There is no service-worker cache in this release, so the SPA itself needs connectivity on first load.
A production deployment can add a cache-first service worker; the API contract requires no change.

## Why not native Flutter

The original scope mentioned native apps. They were not built. Building and shipping iOS/Android
apps requires toolchains, signing identities, store review and a second UI codebase; none of that is
available in this environment, and a scaffold would be dishonest. The PWA plus a well-defined,
idempotent sync contract covers the operational mobile need and keeps one source of truth.

To add native apps later, implement the same two sync endpoints, register devices with
`POST /sync/devices`, and keep `commandId` stable across retries. No server change is needed for a
native housekeeping or maintenance client.

## Device and security notes

- Devices are rows in `mobile.devices`, scoped to the tenant and the user who registered them.
- A session is a bearer token; on a shared tablet, sign out at shift end. There is no device-level
  remote wipe.
- Do not cache payment data or guest identity documents on the device.
- Offline queues must be cleared after successful sync to avoid replaying stale commands; the server
  protects against double application regardless.
