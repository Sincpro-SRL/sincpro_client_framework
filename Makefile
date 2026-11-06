.DEFAULT_GOAL := help

PACKAGE := @sincpro/client-framework

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "  prepare-environment  pre-commit + yarn"
	@echo "  install         yarn install"
	@echo "  init            prepare-environment + install"
	@echo "  format          eslint --fix + prettier, then typecheck"
	@echo "  lint            eslint"
	@echo "  typecheck       tsc --noEmit"
	@echo "  doctor          the rules tsc does not catch: platform-neutral, self-imports"
	@echo "  test            vitest, in Node"
	@echo "  verify-format   format + lint + doctor, then fail if the tree is dirty (CI)"
	@echo "  build           compile into dist/"
	@echo "  update-version  VERSION=x.y.z — release pipeline only, never by hand"
	@echo "  publish         build + publish to NPM (release pipeline)"
	@echo "  clean           remove dist/ and node_modules/"

prepare-environment:
	@pipx install pre-commit
	@pipx ensurepath
	@pre-commit install
	@command -v yarn > /dev/null || npm install -g yarn

install:
	@echo "Installing Node.js dependencies..."
	@yarn install

init: prepare-environment install

typecheck:
	@npx tsc --noEmit

format:
	@echo "🔤 Sorting imports + auto-fix (eslint)..."
	@npx eslint . --fix
	@echo "🎨 Formatting (prettier)..."
	@npx prettier --experimental-cli --write "**/*.{ts,js,json,md}" ".github/**/*.{yaml,yml}" --ignore-path .prettierignore --ignore-unknown
	@echo "Checking types after formatting..."
	@$(MAKE) typecheck

lint:
	@npx eslint .

# The rules `tsc` does not catch. This package runs on every platform — a browser, React Native,
# Node — so what it needs from one it asks through a port, never by reaching for it. Comment
# lines are skipped: an example inside a docstring is documentation, not an import.
SCAN := grep -rnE --include=*.ts
NOT_COMMENT := grep -vE ':[0-9]+: *(\*|//|/\*)'
NOT_CODEGEN := grep -v '^src/codegen/'

doctor:
	@echo "🩺 Checking the rules..."
	@found=0; \
	if $(SCAN) 'from "\.' src | $(NOT_COMMENT); then \
		echo >&2 "✘ relative import — the source imports itself as $(PACKAGE)"; found=1; \
	fi; \
	if $(SCAN) 'from "[^"]+\.ts"' src | $(NOT_COMMENT); then \
		echo >&2 "✘ .ts extension in an import — the build emits it as-is and breaks"; found=1; \
	fi; \
	if $(SCAN) 'from "(react|react-dom|react-native|@sincpro/web-ui|@sincpro/web-composer|@sincpro/criteria-react|@sincpro/mobile[^"]*)["/]' src | $(NOT_COMMENT); then \
		echo >&2 "✘ a UI or a platform imported — this package holds no React and no screen"; found=1; \
	fi; \
	if $(SCAN) '(^|[^.A-Za-z_])(document|window|localStorage|sessionStorage|navigator)\.' src | $(NOT_COMMENT); then \
		echo >&2 "✘ a browser global — ask the platform through a port"; found=1; \
	fi; \
	if $(SCAN) 'from "node:|(^|[^.A-Za-z_])(process|Buffer)\.' src | $(NOT_CODEGEN) | $(NOT_COMMENT); then \
		echo >&2 "✘ Node outside codegen/ — the runtime runs in a browser and on a phone"; found=1; \
	fi; \
	if $(SCAN) 'from "$(PACKAGE)/codegen' src | $(NOT_CODEGEN) | $(NOT_COMMENT); then \
		echo >&2 "✘ codegen/ imported by the runtime — the generator is a build step"; found=1; \
	fi; \
	if [ "$$found" = "1" ]; then exit 1; fi; \
	echo "✓ no rule broken"

test:
	@echo "🧪 Running tests..."
	@npx vitest run

verify-format: format lint doctor
	@if ! git diff --quiet; then \
	  echo >&2 "✘ Formatting changed files. Please add them to the commit."; \
	  git --no-pager diff --name-only HEAD -- >&2; \
	  exit 1; \
	fi
	@echo "✓ Format verification passed"

build:
	@echo "🏗️  Building $(PACKAGE) -> dist (tsc)..."
	@rm -rf dist
	@npx tsc -p tsconfig.build.json
	@npx tsc-alias -p tsconfig.build.json
	@echo "✓ Build ready in ./dist (JS + .d.ts, $(PACKAGE) resolved to relative)"

# `--package-lock=false`: npm (unlike yarn, which manages this repo's installs) doesn't read
# yarn.lock, so without it `npm version` rebuilds a dependency tree against the real registry
# and writes a package-lock.json this repo doesn't keep.
update-version:
ifndef VERSION
	$(error VERSION is required. Usage: make update-version VERSION=1.2.3)
endif
	@CURRENT_VERSION=$$(node -p "require('./package.json').version"); \
	if [ "$$CURRENT_VERSION" = "$(VERSION)" ]; then \
		echo "✓ Version is already $(VERSION), skipping update"; \
	else \
		npm version $(VERSION) --no-git-tag-version --package-lock=false && \
			echo "✓ Version updated to $(VERSION)"; \
	fi

publish: build
	@echo "📦 Publishing $(PACKAGE) to NPM..."
	@if [ -n "$$NPM_TOKEN" ]; then \
		echo "//registry.npmjs.org/:_authToken=$$NPM_TOKEN" > .npmrc.tmp; \
		chmod 600 .npmrc.tmp; \
		npm publish --access public --userconfig .npmrc.tmp; \
		rm -f .npmrc.tmp; \
	else \
		npm publish --access public; \
	fi
	@echo "✓ Published successfully"

deploy:
	@echo "Deploy not applicable for library packages"

clean:
	@rm -rf dist node_modules
	@echo "✓ Cleaned"

.PHONY: help prepare-environment install init typecheck format lint doctor test verify-format build \
	update-version publish deploy clean
