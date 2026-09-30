# One-time: lets this PC copy songs to your Umbrel without typing a password each time.
# You will be asked for your Umbrel password (the one you use to log in to Umbrel / SSH) once or twice.
$Ssh = "umbrel@100.69.236.80"
$key = Join-Path $env:USERPROFILE ".ssh\id_ed25519"
if (-not (Test-Path $key)) { ssh-keygen -t ed25519 -N '""' -f $key }
Get-Content "$key.pub" | ssh $Ssh "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && mkdir -p ~/umbrel/data/storage/downloads/music"
ssh -o BatchMode=yes $Ssh "echo SSH key login works"
