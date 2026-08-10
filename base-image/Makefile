VERSION      ?= 0.1.0
SSH_PASSWORD ?= openclaw
TOOLS        := .tools
PACKER       := $(shell command -v packer 2>/dev/null || echo $(TOOLS)/packer)
TEMPLATE     := packer/openclaw-base.pkr.hcl
OUTPUT       := output/openclaw-base-$(VERSION)

.PHONY: build validate init tools creds clean help

help:
	@echo "make build [VERSION=x.y.z] [SSH_PASSWORD=...]  build the qcow2 image"
	@echo "make validate                                  packer init + validate"
	@echo "make creds [VERSION=x.y.z]                     show login credentials for a built image"
	@echo "make clean VERSION=x.y.z                       remove that version's output dir"

tools:
	@test -x $(PACKER) || { \
	  echo "Downloading packer..."; mkdir -p $(TOOLS); \
	  VER=$$(curl -fsSL https://checkpoint-api.hashicorp.com/v1/check/packer | jq -r .current_version); \
	  curl -fsSL -o $(TOOLS)/packer.zip https://releases.hashicorp.com/packer/$$VER/packer_$${VER}_linux_amd64.zip; \
	  unzip -o -d $(TOOLS) $(TOOLS)/packer.zip packer; rm $(TOOLS)/packer.zip; }

init: tools
	$(PACKER) init $(TEMPLATE)

validate: init
	$(PACKER) validate -var version=$(VERSION) -var ssh_password=$(SSH_PASSWORD) $(TEMPLATE)

build: validate
	@test ! -e $(OUTPUT) || { echo "$(OUTPUT) already exists — bump VERSION or 'make clean VERSION=$(VERSION)'"; exit 1; }
	$(PACKER) build -var version=$(VERSION) -var ssh_password=$(SSH_PASSWORD) $(TEMPLATE)

creds:
	@cat $(OUTPUT)/credentials.txt

clean:
	rm -rf $(OUTPUT)
