# Contributing

Use Node 24 and the pinned pnpm version. Run the native build, workspace build, typecheck, lint, workspace tests and native-client tests before proposing changes. Native integration changes also need a rendered browser check; live Discord/mobile/Authentik verification must be reported separately from mock tests.

Keep deployment examples generic. Never commit operator hostnames, guild IDs, credentials, databases, profiles or runtime logs. Preserve license attribution and the pinned native source/build recipe. Avoid compatibility shims unless explicitly requested; update the adapter and its tests together when changing the supported upstream version.
