# Every entry point for this project. `make` alone lists them.
# `make dev` is the only one you need during the hackathon; the rest are escape hatches.
# The Vite app is at the repo root, so WEB_DIR is `.` — change it only if you move it.

WEB_DIR := .
API_DIR := backend
PY      := $(API_DIR)/.venv/bin/python
QRCODE  := qrcode>=7.4,<9

.DEFAULT_GOAL := help
.PHONY: help dev web api qr install build typecheck clean

help: ## Show this help
	@grep -hE '^[a-z][a-z0-9_-]*:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}'

dev: ## Backend + frontend together, with the LAN URL and a QR code for your phone
	@bash scripts/dev.sh

web: ## Frontend only, HTTPS on 0.0.0.0:5173
	@npm --prefix $(WEB_DIR) run dev -- --host 0.0.0.0

api: ## Backend only, hot reload on 0.0.0.0:8000 (expects backend/main.py:app)
	@cd $(API_DIR) && .venv/bin/python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

qr: ## Reprint the LAN URL and QR code without restarting anything
	@$(PY) scripts/lan.py

install: ## Install everything: npm packages, the Python venv, and the QR tool
	@npm --prefix $(WEB_DIR) install && python3 -m venv $(API_DIR)/.venv && $(PY) -m pip install --upgrade pip && $(PY) -m pip install -r $(API_DIR)/requirements.txt '$(QRCODE)'

build: ## Production frontend bundle → dist/
	@npm --prefix $(WEB_DIR) run build

typecheck: ## TypeScript, no emit — run this before you claim it works
	@npm --prefix $(WEB_DIR) run typecheck

clean: ## Delete node_modules, the venv, dist and caches
	@rm -rf $(WEB_DIR)/node_modules $(WEB_DIR)/dist $(API_DIR)/.venv $(API_DIR)/__pycache__ && echo "cleaned — run 'make install' to get back"
