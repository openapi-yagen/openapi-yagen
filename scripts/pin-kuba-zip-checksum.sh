#!/bin/sh
# GitHub now serves kuba-zip 0.3.2's source archive with different bytes (same files inside) than
# those the sha256 in the ConanCenter recipe was computed from, so building it from source fails
# with "sha256 hash failed". This replaces that sha256 in the locally cached recipe. Run it before
# `conan install`, in the same shell step; it needs network access to ConanCenter.
#
# Remove once ConanCenter ships a fixed recipe:
# https://github.com/conan-io/conan-center-index/issues/31536
set -eu

old=0c33740aec7a3913bca07df360420c19cac5e794e0f602f14f798cb2e6f710e5
new=ebf489143d89761bec01353d2b3ea74b136ee5426a91a8b5bfbc0b685e49af7b

conan download "kuba-zip/0.3.2" --only-recipe -r conancenter
conandata="$(conan cache path kuba-zip/0.3.2)/conandata.yml"
# -i with a suffix is the one in-place form both GNU and BSD (macOS) sed accept.
sed -i.bak "s/$old/$new/" "$conandata"
rm "$conandata.bak"
