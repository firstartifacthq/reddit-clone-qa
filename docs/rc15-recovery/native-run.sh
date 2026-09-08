#!/bin/sh
set -eu
export EVIDENCE="$PWD/.crabbox/evidence/rc15/native"
mkdir -p "$EVIDENCE"
export NATIVE_RUNTIME=$(mktemp -d /tmp/software-factory/at-XXXXXX)
export DISPLAY=:99 XDG_RUNTIME_DIR="$NATIVE_RUNTIME" XDG_CONFIG_HOME="$NATIVE_RUNTIME/config" XDG_CACHE_HOME="$NATIVE_RUNTIME/cache" XDG_DATA_HOME="$NATIVE_RUNTIME/data"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
export XDG_DATA_DIRS="/nix/store/cjraidmmw39g7xsxsj51sszbx8wplig5-at-spi2-core-2.60.6/share:/nix/var/nix/profiles/default/share:/usr/share"
export PULSE_SERVER="unix:$NATIVE_RUNTIME/pulse/native"
export SPEECHD_ADDRESS="unix_socket:$NATIVE_RUNTIME/speech.sock"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$NATIVE_RUNTIME/bus"
dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --nofork >"$EVIDENCE/dbus.log" 2>&1 & bus_pid=$!
sleep 1
cleanup() { kill ${recorder:-} ${orca_pid:-} ${speech_pid:-} ${pulse_pid:-} ${bus_pid:-} 2>/dev/null || true; }
trap cleanup EXIT INT TERM
pulseaudio -n --daemonize=no --exit-idle-time=-1 --load="module-native-protocol-unix socket=$XDG_RUNTIME_DIR/pulse/native" --load="module-null-sink sink_name=rc15" >"$EVIDENCE/pulse.log" 2>&1 & pulse_pid=$!
sleep 2
mkdir -p "$NATIVE_RUNTIME/speech-config"
cat > "$NATIVE_RUNTIME/speech-config/speechd.conf" <<EOF
LogLevel 5
AudioOutputMethod "pulse"
AddModule "espeak-ng" "sd_espeak-ng" "/nix/var/nix/profiles/default/etc/speech-dispatcher/modules/espeak-ng.conf"
DefaultModule "espeak-ng"
EOF
speech-dispatcher -C "$NATIVE_RUNTIME/speech-config" -m /nix/var/nix/profiles/default/libexec/speech-dispatcher-modules -s -S "$XDG_RUNTIME_DIR/speech.sock" -P "$XDG_RUNTIME_DIR/speech.pid" -L "$EVIDENCE" -l 5 -t 0 >"$EVIDENCE/speech-start.log" 2>&1 & speech_pid=$!
sleep 2
parec --device=rc15.monitor --file-format=wav "$EVIDENCE/speech.wav" >"$EVIDENCE/record.log" 2>&1 & recorder=$!
orca --debug-file "$EVIDENCE/orca.log" >"$EVIDENCE/orca-start.log" 2>&1 & orca_pid=$!
sleep 4
kill -0 "$speech_pid" "$orca_pid" "$pulse_pid" "$bus_pid"
node --no-warnings .crabbox/evidence/rc15/native-observe.mjs

