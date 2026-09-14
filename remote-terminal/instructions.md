<!-- managed-remote-terminal:start -->
## Private remote terminal (enabled for this Claw)

When your owner explicitly asks for a remote terminal, shell, console, or an
interactive CLI login, run `node remote-terminal/session.mjs create` in your
workspace. It opens a dedicated interactive shell as the container's node user
in this same workspace. It does not attach to an already running exec command.
This installed capability needs no new tunnel or infrastructure approval.

The owner owns this Claw; 8Examples provisions and hosts it. Help them administer
their plugins, configuration, models, skills and files. Their authorized changes
inside their Claw do not require the provisioner's permission. The terminal page
offers **Open admin shell** when container administration is enabled. In that
shell, `openclaw` runs as the Claw user so plugin/config files remain usable by
the agent; other commands run as root in this owner's container. Their shell
startup configuration is respected. Saved owner configuration and installed
skills survive provisioning; system changes on admin-enabled Claws are
checkpointed before managed container recreation.

An owner can also sign in at https://8examples.com/account and open their
terminal there, including when the Claw cannot reply in chat. This account path
checks current ownership and supplies a fresh one-time code.

Send the returned `https://8examples.com/remote-terminal/<uuid>` link, six-digit
code (preserve leading zeroes), and expiry only in the owner's private chat.
Never invent a link or code. Never send localhost/private-IP/SSH addresses as
the remote connection. Do not use a browser handoff URL for a terminal request.
If creation fails, report the helper's actual error without exposing account.json.

Tell the owner: open the link, enter the connection code, use the terminal,
choose **End terminal**, then reply in chat. The connection lasts 15 minutes.
Closing it stops its interactive shell; files and account logins it saved remain
in the Claw's container. Programs deliberately detached by the owner may remain.
The code opens this terminal; it is not the destination account's 2FA.
Keep destination 2FA enabled and complete verification in the CLI or website.
Do not ask for passwords, one-time login codes, or recovery codes in chat.

End your turn and leave the owner's terminal and related task alone while it
is connected: no screenshots, terminal output inspection, exec interference,
or subagents working on the same files/account. This is an instruction to pause,
not a lock on every tool in the container. After the owner replies, run
`node remote-terminal/session.mjs status` before continuing. End terminal does
not itself prove a CLI login or command succeeded; verify the requested result.
Use `node remote-terminal/session.mjs revoke` to close the handoff if asked.
The terminal does not automatically message the chat when closed.
<!-- managed-remote-terminal:end -->
