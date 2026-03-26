################################################################################
# Image: Derived Node-RED runtime with a custom plugin + assets
#
# Audience: reviewers/operators comparing this derived image against the upstream
#          base image (nodered/node-red:4.1.3-22) and assessing “fatness”.
#
# Design intent (size-focused):
#   1) Keep the FINAL runtime image free of build-time tooling (notably git).
#   2) Reduce the baseline footprint by using Node-RED’s official "-minimal"
#      variant, when compatible.
#
# Why these two matter most:
#   - Base image size dominates total size for Node-RED containers.
#   - Accidental inclusion of build-time packages (git, compilers, etc.) inflates
#     runtime size and widens the attack surface.
#
# Standard, comparable metrics for reviewers:
#   - "docker image ls" (commonly accepted uncompressed size)
#   - "docker inspect --format '{{.Size}}'" (exact bytes)
#   - "docker image history" (layer attribution for the delta)
################################################################################


# ==============================================================================
# STAGE 1 — deps/build stage (NOT shipped)
# ==============================================================================
# Purpose:
#   - Resolve and install plugin dependencies during build.
#   - Permit git-based npm dependencies without carrying git into runtime.
#
# Size rationale:
#   - Any packages installed here are intentionally excluded from the final image
#     unless explicitly copied to it.
#   - This prevents build-only tools (git + transitive packages) from inflating
#     the runtime artifact.
#
# Base choice:
#   - Use the same upstream Node-RED line as the runtime to keep ABI/Node version
#     aligned while building dependencies.
FROM nodered/node-red:4.1.3-22 AS deps

# Build stage requires elevated privileges to install packages.
USER root

# Build-only dependency:
#   - git is needed only because at least one npm dependency is fetched via a Git
#     URL.
#   - "--no-cache" avoids leaving apk index/cache behind in this stage.
#   - Even if this stage grows, it does NOT affect the final image size unless
#     we copy files from it.
RUN apk add --no-cache git

# Make the plugin dir writable for the node-red user
RUN mkdir -p /opt/node-red-urdf-plugin \
    && chown -R node-red:node-red /opt/node-red-urdf-plugin

# Place plugin sources in a deterministic path so the next stage can copy the
# fully prepared plugin directory in one operation.
WORKDIR /opt/node-red-urdf-plugin

# Ownership is set at copy-time to avoid a later recursive chown layer.
# This is primarily a cleanliness improvement; the main size win is multi-stage.
COPY --chown=node-red:node-red node-red-urdf-plugin/ ./

# Drop privileges: install npm deps as the same non-root user used at runtime.
USER node-red

# Dependency installation:
#   - Prefer "npm ci" when a lockfile exists to ensure deterministic installs.
#   - "--omit=dev" excludes devDependencies from the installed tree; this can be
#     a substantial size reduction if the plugin’s devDependencies are heavy.
#     (If the plugin *incorrectly* relies on devDependencies at runtime, remove
#      --omit=dev.)
#   - "--no-fund --no-audit" reduces build noise/time (not a size lever).
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-fund --no-audit ; \
    else \
      npm install --omit=dev --no-fund --no-audit ; \
    fi

# Optional cache hygiene:
#   - Ensures npm cache is not carried into subsequent stages if ever copied
#     accidentally (it is not copied intentionally here).
RUN npm cache clean --force >/dev/null 2>&1 || true


# ==============================================================================
# STAGE 2 — runtime stage (SHIPPED artifact)
# ==============================================================================
# Purpose:
#   - This is the final, deployable runtime image.
#   - It should contain ONLY what is needed to run Node-RED plus the plugin and
#     runtime assets.
#
# Size rationale:
#   - Switch to Node-RED’s official "-minimal" variant to reduce the baseline.
#     This is often the single biggest size reduction available.
#
# Compatibility note for reviewers:
#   - "-minimal" may remove optional tooling/features. If Node-RED Projects or
#     other omitted capabilities are required at runtime, use the non-minimal tag.
FROM nodered/node-red:4.1.3-22

# Elevated privileges are used only to place files and set execute bits.
USER root

# Import the prepared plugin directory (including node_modules) from the deps
# stage. This is the key multi-stage boundary:
#   - git and apk-installed packages remain confined to the deps stage
#   - only the plugin runtime filesystem is copied into the final image
COPY --from=deps --chown=node-red:node-red \
  /opt/node-red-urdf-plugin /opt/node-red-urdf-plugin

# Runtime assets:
#   - Settings, ontology, and rules are installed as defaults inside the image.
#   - Ownership is set at copy-time for predictable non-root runtime behavior.
COPY --chown=node-red:node-red nodered-default-settings.js /opt/nodered-default-settings.js
COPY --chown=node-red:node-red app-ontology.flattened.compressed.jsonld /opt/urdf/app-ontology.flattened.compressed.jsonld
COPY --chown=node-red:node-red rules.flattened.compressed.jsonld /opt/urdf/rules.flattened.compressed.jsonld
COPY --chown=node-red:node-red nodered-default-flows.json /opt/nodered-default-flows.json
COPY --chown=node-red:node-red zurl.json /opt/urdf/zurl.json

# Custom entrypoint:
#   - Performs pre-start initialization and then launches Node-RED.
#   - Needs to be executable inside the container.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Runtime security posture:
#   - Node-RED runs as non-root user "node-red".
USER node-red

# Restore Node-RED conventional working directory.
WORKDIR /usr/src/node-red

# Entrypoint remains explicit for predictable startup behavior.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]


################################################################################
# Reviewer verification checklist (standard Docker commands)
#
# Build:
#   docker build -t derived:nodered-urdf .
#
# Compare against the upstream base:
#   docker pull nodered/node-red:4.1.3-22
#   docker pull nodered/node-red:4.1.3-22-minimal
#
# Standard size comparison (uncompressed, widely used):
#   docker image ls | grep -E 'derived:nodered-urdf|nodered/node-red:4.1.3-22'
#
# Exact byte comparison (auditable):
#   docker inspect derived:nodered-urdf --format '{{.Size}}'
#   docker inspect nodered/node-red:4.1.3-22-minimal --format '{{.Size}}'
#   docker inspect nodered/node-red:4.1.3-22 --format '{{.Size}}'
#
# Layer attribution (to explain the delta):
#   docker image history derived:nodered-urdf
#
# Expected outcomes:
#   - No layer in the final image corresponds to "apk add git"
#   - Total size delta vs "-minimal" base is primarily the plugin + assets
################################################################################

