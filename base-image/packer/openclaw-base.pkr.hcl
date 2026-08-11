packer {
  required_plugins {
    qemu = {
      source  = "github.com/hashicorp/qemu"
      version = ">= 1.1.0"
    }
  }
}

variable "version" {
  type    = string
  default = "0.1.0"
}

variable "ssh_username" {
  type    = string
  default = "openclaw"
}

# Also the desktop autologin user's password and the sudo password.
# Override per build: packer build -var ssh_password=...
variable "ssh_password" {
  type    = string
  default = "openclaw"
}

variable "disk_size" {
  type    = string
  default = "40G"
}

variable "memory" {
  type    = number
  default = 8192
}

variable "cpus" {
  type    = number
  default = 4
}

variable "headless" {
  type    = bool
  default = true
}

locals {
  image_name = "openclaw-base-${var.version}"
  output_dir = "${abspath(path.root)}/../output/${local.image_name}"
}

source "qemu" "openclaw_base" {
  iso_url      = "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
  iso_checksum = "file:https://cloud-images.ubuntu.com/noble/current/SHA256SUMS"
  disk_image   = true

  disk_size      = var.disk_size
  format         = "qcow2"
  accelerator    = "kvm"
  cpu_model      = "host"
  memory         = var.memory
  cpus           = var.cpus
  headless       = var.headless
  net_device     = "virtio-net"
  disk_interface = "virtio"

  ssh_username = var.ssh_username
  ssh_password = var.ssh_password
  ssh_timeout  = "20m"

  cd_label = "cidata"
  cd_content = {
    "meta-data" = "instance-id: openclaw-base-build\nlocal-hostname: openclaw-base\n"
    "user-data" = templatefile("${abspath(path.root)}/cloud-init/user-data.pkrtpl", {
      username = var.ssh_username
      password = var.ssh_password
    })
  }

  shutdown_command = "echo '${var.ssh_password}' | sudo -S shutdown -P now"

  output_directory = local.output_dir
  vm_name          = "${local.image_name}.qcow2"
}

build {
  sources = ["source.qemu.openclaw_base"]

  provisioner "shell" {
    execute_command  = "echo '${var.ssh_password}' | {{ .Vars }} sudo -S -E bash '{{ .Path }}'"
    environment_vars = [
      "OPENCLAW_USER=${var.ssh_username}",
      "OPENCLAW_PASSWORD=${var.ssh_password}",
    ]
    scripts = [
      "${abspath(path.root)}/../scripts/05-base.sh",
      "${abspath(path.root)}/../scripts/10-desktop.sh",
      "${abspath(path.root)}/../scripts/20-chrome.sh",
      "${abspath(path.root)}/../scripts/30-openclaw.sh",
      "${abspath(path.root)}/../scripts/40-claude-auth.sh",
      "${abspath(path.root)}/../scripts/50-devtools.sh",
      "${abspath(path.root)}/../scripts/55-productivity.sh",
      "${abspath(path.root)}/../scripts/60-sunshine.sh",
      "${abspath(path.root)}/../scripts/65-tailscale.sh",
      "${abspath(path.root)}/../scripts/70-hardening.sh",
      "${abspath(path.root)}/../scripts/90-cleanup.sh",
    ]
  }

  post-processor "manifest" {
    output = "${local.output_dir}/manifest.json"
  }

  post-processor "shell-local" {
    inline = [
      "printf 'image: %s.qcow2\\nssh + desktop user: %s\\npassword: %s\\nsudo password: %s\\nsunshine web ui: https://<vm-ip>:47990 (user %s, same password; pair Moonlight clients there)\\n' '${local.image_name}' '${var.ssh_username}' '${var.ssh_password}' '${var.ssh_password}' '${var.ssh_username}' > '${local.output_dir}/credentials.txt'",
      "cd '${local.output_dir}' && sha256sum '${local.image_name}.qcow2' > SHA256SUMS",
    ]
  }
}
