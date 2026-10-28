# Hosted project provisioning

`src/renderer/sync/provision/hosted-runtime.ts` owns the supported App provisioning
runtime. It responds to database readiness, authored commits, foreground/resume,
authority changes and connectivity. Only a configured Hosted service with a bound
account can publish pending project generations. The provider-neutral repository,
provisioner and supervisor preserve durable retry, cancellation and deletion holds.

Google Drive provisioning and its runtime entrypoints were removed on 2026-10-28.
The production runtime mounts only Hosted project and Agent conversation bindings.
Historical SQLite provider values remain readable for local-replica adoption.

See [Hosted behavior and generated evidence](../hosted-sync/README.md).
