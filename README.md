# Hub Analytics

An authenticated two-page viewer and a constrained collection adapter around Umami. Umami remains the analytics store. Reports count accepted visits and one effective click per visit and destination.

This repository is a public source snapshot. It contains application code, the public destination catalog, dependency versions, deployment examples, and a content manifest. It contains no real environment file, deployment credentials, internal host inventory, database backup, or prior repository history. Public deployment URLs and the public website itself are observable independently of source visibility; passwords and management tokens must remain private.

## Services

Use three separate resources:

1. PostgreSQL 15, with persistent storage and a tested backup procedure.
2. An internal Umami service using the official fixed image below.
3. This Node application, built from the root Dockerfile. It listens on port 8080 as the non-root `node` user. Runtime configuration is read from `process.env`.

```text
ghcr.io/umami-software/umami@sha256:f2c645cc5cdff76e7fbfe4c7eeabc7e363840bd34364f4f719b69d11f9ef1c19
```

This pins the Linux amd64 Umami 3.4.1 image. For another architecture, independently verify and select the corresponding official manifest. The Node application image uses a separately pinned public Node 24 image; no private registry credentials are required to read either public image.

Keep Umami and PostgreSQL on internal networking. The collection adapter calls Umami internally. Do not publish Umami's management UI or its unrestricted collection endpoint as a shortcut.

**The current application serves both a password-protected viewer and the public collection adapter on the same port.** Hosting the whole application publicly is supported: reporting queries require a valid viewer session. Password protection restricts access to report data; it does not make the application network-private. If network-level isolation is required, make this service port private, which also makes its collection endpoint private. A separate public collector would then need a later implementation. This snapshot has no collector-only switch.

## Northflank secrets: where to enter real values

In the project, create a **Secret Group**. Choose **Runtime variables only** (sometimes displayed as Runtime Only), enter values in the key/value or ENV editor, and use **Advanced / linked services** to restrict inheritance to the intended service. Secret groups can otherwise be inherited by all services and jobs in a project. Do not select build arguments or the combined build/runtime type for these credentials.

| Runtime group | Attach only to | Values |
|---|---|---|
| Application runtime | This application service | Variables listed in `.env.example`; use restricted database accounts, the actual service origin, and real random secrets |
| Umami runtime | Internal Umami service | `DATABASE_URL` for Umami's migration/write account, `APP_SECRET`, `TWO_FACTOR_ENCRYPTION_KEY`, `PRIVATE_MODE=1`, `DISABLE_TELEMETRY=1`, `DISABLE_UPDATES=1`, `NEXT_TELEMETRY_DISABLED=1`, `TZ=UTC` |

The application's `UMAMI_APP_SECRET` must equal the internal Umami service's `APP_SECRET`; store the values privately in the two scoped runtime groups. Leave `DISABLE_BOT_CHECK` unset. Never put real values into the Dockerfile, Docker build arguments, GitHub source, issues, screenshots, or build output. Service-level variables override same-name inherited values, so inspect both places when troubleshooting.

Official references: [Inject secrets](https://northflank.com/docs/v1/application/secure/inject-secrets), [Manage secret groups](https://northflank.com/docs/v1/application/secure/manage-secret-groups), and [runtime variables](https://northflank.com/docs/v1/application/run/inject-runtime-variables).

The Docker build installs only locked production dependencies and explicitly copies runtime files. It does not require a database or any application secret. `.env.example` contains placeholders and is not a working configuration.

For cloud database connections, use `sslmode=verify-full` and the provider's actual database hostname. If the provider uses a private certificate authority, mount the CA certificate as a runtime secret file and configure the PostgreSQL client's CA trust. Keep certificate and hostname verification enabled; do not work around connection errors by disabling TLS verification. Private networking and database credentials remain separate controls.

## Initialize privately before public access

1. Create the dedicated database and start Umami on an internal port. Allow its reviewed schema migration to complete.
2. Access Umami using an authenticated administrative connection or port forward. Replace Umami's documented initial `admin` / `umami` login with a strong private password **before exposing any related administrative route to the public**. Confirm the initial password no longer works. Create the website and retain its generated UUID in runtime configuration.
3. Create a report account with only SELECT on `public.website_event`, `public.event_data`, and `public.website`; it must not read `public."user"` or write analytics tables. Create a separate receipt account with only SELECT/INSERT/UPDATE/DELETE on `hub.collect_receipt`. Neither account should own the database or schema.
4. Create the receipt table and its expiration index using the privileged initialization connection:

```sql
CREATE SCHEMA IF NOT EXISTS hub;
CREATE TABLE IF NOT EXISTS hub.collect_receipt (
  event_id uuid PRIMARY KEY,
  owner_hash text NOT NULL,
  payload_hash text NOT NULL,
  identity_id text NOT NULL,
  status text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS collect_receipt_expires_at_idx
  ON hub.collect_receipt (expires_at);
```

5. Configure the application's real runtime values. Generate the viewer password hash in the format `scrypt:v1:<base64url salt>:<base64url key>`, using scrypt N=32768, r=8, p=1, maxmem=64 MiB, and a 32-byte derived key. The plaintext viewer password is distributed privately, never committed.
6. Set `PUBLIC_ORIGIN` to the exact HTTPS application origin and `ALLOWED_COLLECT_ORIGINS` to the actual public website origin. Verify which direct proxy supplies forwarded client IPs before configuring proxy trust. Do not trust arbitrary browser-supplied forwarding headers.
7. Start the application. Check `/healthz`, unauthenticated-query rejection, successful authenticated viewing, ordinary event acceptance, bot rejection, repeated-click deduplication, and database permission failures. Isolate test traffic from real collection.

The example configuration and container default to `DATA_MODE=demo`. Demo mode labels data as a trial; it does not fabricate analytics or replace the need for a working Umami database. Use a separate trial website for test traffic. Switching to `DATA_MODE=live` requires a dedicated real website UUID, an explicit production configuration, and `COLLECTION_STARTED_AT` set to the true collection start. Do not relabel trial traffic as production or invent historical coverage.

Public rollout also requires a reviewed website collector endpoint, content security policy, TLS, and target-network checks. Confirm the chosen free resource allocations and account plan before creating resources; no paid upgrade is implied by this source.

## Build and run

```bash
docker build -t hub-analytics:reviewed .
# Configure real runtime values through the hosting platform's secret editor.
```

For a container run managed outside the platform, use a private runtime environment file stored outside the repository. Do not include that file in the build context. The startup command is `node server/index.mjs`; the image sets `HOST=0.0.0.0` and `PORT=8080`.

`PUBLIC-EXPORT-MANIFEST.json` records each exported file's SHA-256. This is a reviewable snapshot; regenerate and review the final snapshot before publishing changes. Source review and image construction do not by themselves confirm a successful cloud deployment.

## License

This application uses the [MIT License](LICENSE), with the same notice as AMD Developer Hub. Dependencies and the separately deployed Umami image retain their own licenses.
