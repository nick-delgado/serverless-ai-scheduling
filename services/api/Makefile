# Lambda bundles for infra/stacks/api.yaml (SAM `BuildMethod: makefile`).
#
# Why not `BuildMethod: esbuild`: SAM copies CodeUri to a scratch dir and runs `npm install` there in
# isolation, which cannot resolve workspace packages such as `@sched/contracts` (they export TypeScript
# source and are not on the npm registry). Instead, api.yaml sets `Metadata.WorkingDirectory` to the repo
# root, so SAM runs this Makefile there and esbuild resolves workspace packages through the root
# node_modules, exactly like the tests do. SAM sets ARTIFACTS_DIR to the function's build output.
#
# Try it locally: make -f services/api/Makefile build-ChatFunction ARTIFACTS_DIR=/tmp/chat

ESBUILD := npx --no-install esbuild
# ESM output for nodejs24.x. The banner gives bundled CommonJS dependencies a working `require`.
ESBUILD_FLAGS := --bundle --platform=node --target=node24 --format=esm --main-fields=module,main \
	--sourcemap --sources-content=false --legal-comments=none --log-level=warning \
	--banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

.PHONY: check-root build-ChatFunction

check-root:
	@test -f services/api/Makefile || { echo "run from the repo root (api.yaml sets WorkingDirectory)" >&2; exit 1; }
	@test -n "$(ARTIFACTS_DIR)" || { echo "ARTIFACTS_DIR is not set" >&2; exit 1; }

build-ChatFunction: check-root
	$(ESBUILD) services/api/src/handlers/chat.ts $(ESBUILD_FLAGS) --outfile="$(ARTIFACTS_DIR)/index.mjs"
