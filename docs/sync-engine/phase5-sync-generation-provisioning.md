# Hosted project provisioning

`src/renderer/sync/provision/hosted-runtime.ts` owns the supported App provisioning
runtime. It responds to database readiness, authored commits, foreground/resume,
authority changes and connectivity. Only a configured Hosted service with a bound
account can publish pending project generations. The provider-neutral repository,
provisioner and supervisor preserve durable retry, cancellation and deletion holds.

The production runtime mounts only Hosted project and Agent conversation bindings.

See [Hosted behavior and generated evidence](../hosted-sync/README.md).
