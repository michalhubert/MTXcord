#!/usr/bin/env bash
# Run from an MTXcord checkout at the commit the case was written against.
set -eu
git apply "$(dirname "$0")/files/change.patch"
