# Argus documentation

- **[Architecture](architecture.md):** how Argus is put together. Covers the single image and its runtime roles, the database-agnostic data layer, and the lifecycle of a request and of a scan.
- **[Security model](security.md):** what Argus protects and how. Covers encryption at rest, authentication, sessions, auditing, source-code handling and AI guardrails.
- **[Features](features/README.md):** the feature catalogue, with the delivery status of each feature.
  - [User management](features/user-management.md)
  - [Sources, repositories and scans](features/sources-and-repositories.md)
  - [Scanners, findings and risk scoring](features/scanners-and-findings.md)
- **[Configuration](configuration.md):** environment variables and in-app settings.
- **Deployment**
  - [Docker and docker compose](deployment/docker.md)
  - [Azure Web App for Containers](deployment/azure.md)
- **[Development](development.md):** working on Argus itself.
