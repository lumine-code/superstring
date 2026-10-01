#!/bin/bash
set -euo pipefail

# When compiling `superstring` on macOS, we used to be able to rely on the
# builtin version of `libiconv`. But newer versions of macOS include FreeBSD
# `libiconv`, rather than GNU `libiconv`; the two are not API-compatible.
#
# For this reason, we download a known good version of `libiconv` from
# https://github.com/apple-oss-distributions/libiconv/tree/libiconv-61.
#
# We might eventually replace this approach with an explicit vendorization of
# the specific files needed, but that would require a universal build of
# `libiconv.2.dylib`. For now, letting the user compile their own `libiconv`
# has the advantage of very likely matching the system's architecture.

echoerr() { printf '%s\n\n' "$*" >&2; }

create-if-missing() {
  if [ -f "$1" ]; then
    echoerr "Error: $1 is a file."
    usage
    exit 1
  fi
  if [ ! -d "$1" ]; then
    mkdir -p "$1"
  fi
}

usage() {
  echoerr "superstring requires the GNU libiconv library, which macOS no longer bundles in recent versions. This package attempts to compile it from GitHub. If you're seeing this message, something has gone wrong; check the README for information and consider filing an issue."
}

# Gyp supplies the same configured minimum to the addon, tests and this build.
# A direct invocation may instead provide it through the compiler environment.
deployment_target="${1:-${MACOSX_DEPLOYMENT_TARGET:-13.5}}"
if [[ ! "$deployment_target" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]]; then
  echoerr "Pass a macOS deployment target, such as 13.5."
  exit 1
fi
export MACOSX_DEPLOYMENT_TARGET="$deployment_target"

# Identify the directory of this script.
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

ROOT="$SCRIPT_DIR/.."
SCRATCH="$ROOT/scratch"
EXT="$ROOT/ext"
stamp_tmp=""

cleanup() {
  if [ -n "$stamp_tmp" ]; then
    rm -f "$stamp_tmp"
  fi
  if [ -d "$SCRATCH" ]; then
    rm -rf "$SCRATCH"
  fi
}
trap cleanup SIGINT EXIT

create-if-missing "$EXT"
create-if-missing "$SCRATCH"

dylib_path="$EXT/lib/libiconv.2.dylib"
target_stamp="$EXT/libiconv-deployment-target-$deployment_target"
recorded_target=""
if [ -f "$target_stamp" ]; then
  recorded_target="$(cat "$target_stamp")"
fi

# A library compiled for the host's newer OS cannot accompany an addon whose
# minimum is older. Target-specific output names also invalidate Gyp's action
# when a caller changes the configured minimum during an incremental build.
if [ ! -e "$dylib_path" ] || [ "$recorded_target" != "$deployment_target" ]; then
  echo "Building libiconv for macOS $deployment_target."
  # A failed build must never leave a stamp claiming its partial output is usable.
  rm -f "$EXT"/libiconv-deployment-target-*
  cd "$SCRATCH"
  # TODO: Instead of downloading this each time, we can check this into source
  # control via git subtree. That would allow someone to build this without
  # needing internet connectivity. But we'd still need to do a `make install` —
  # at least until we can produce a "universal" version of the `.dylib` and put
  # _that_ in source control.
  git clone -b libiconv-61 "https://github.com/apple-oss-distributions/libiconv.git"
  cd libiconv/libiconv
  ./configure --enable-extra-encodings --prefix="$EXT" --libdir="$EXT/lib"
  make
  make install

  if [ ! -e "$dylib_path" ]; then
    echoerr "Error: expected $dylib_path to be present, but it was not. Installation of libiconv failed. Cannot proceed."
    usage
    exit 1
  fi

  # Remove the directories we don't need.
  rm -rf "$EXT/bin"
  rm -rf "$EXT/share"

  # Copy over the license and README from the scratch directory.
  cp "COPYING.LIB" "$EXT"
  cp "README" "$EXT"
else
  echo "Path $dylib_path already targets macOS $deployment_target; skipping installation of libiconv."
fi

cd "$ROOT"

if [ ! -e "$dylib_path" ]; then
  echoerr "Error: expected $dylib_path to be present, but it was not. Cannot proceed."
  usage
  exit 1
fi

# Set the install name of this library to something neutral and predictable to
# make a later step easier.
#
# NOTE: macOS complains about this action invalidating the library's code
# signature. This has not been observed to have any negative effects for
# Lumine, possibly because we sign and notarize the entire app at a later stage
# of the build process. But if it _did_ have negative effects, we could switch
# to a different approach and skip this step. See the `binding.gyp` file for
# further details.

install_name_tool -id "libiconv.2.dylib" "${dylib_path}"

stamp_tmp="$(mktemp "$EXT/.libiconv-deployment-target.XXXXXX")"
printf '%s\n' "$deployment_target" > "$stamp_tmp"
mv -f "$stamp_tmp" "$target_stamp"
stamp_tmp=""

cleanup
