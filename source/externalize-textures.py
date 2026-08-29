#!/usr/bin/env python3
# The glider model is embedded in Glider.glb and (via merge-glider-into-avatar.mjs) in each of the
# five *Rig.glb clips, so its four 1024x1024 PNGs shipped six times over: 13.1MB of the scene's
# 22.2MB of GLBs was the same four images. This rewrites a GLB's embedded images out to shared files
# and points the GLB at them by URI, so all six share one copy - one download, one GPU upload.
#
# glTF-Transform can't do this (writeBinary re-embeds images regardless of setURI), hence the manual
# chunk surgery. Run after merge-glider-into-avatar.mjs, from this directory:
#   python3 externalize-textures.py
# Re-running is a no-op for files that are already externalized.
import json
import os
import struct

DIR = "../assets/animations"
TEX_DIR = f"{DIR}/textures"
URI_PREFIX = "textures/"
EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg"}

# Glider.glb is the merge input; the *Rig.glb files are its outputs (see merge-glider-into-avatar.mjs).
TARGETS = [
    "Glider",
    "Gliding_AvatarForwardRig",
    "Gliding_AvatarIdleRig",
    "Gliding_AvatarStartRig",
    "Gliding_AvatarEndRig",
    "Hard_Landing_GliderRig",
]

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def read_glb(path):
    data = open(path, "rb").read()
    if data[:4] != b"glTF":
        raise ValueError(f"{path}: not a GLB")
    offset, gltf, binary = 12, None, b""
    while offset < len(data):
        length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + length]
        offset += length
        if chunk_type == JSON_CHUNK:
            gltf = json.loads(chunk)
        elif chunk_type == BIN_CHUNK:
            binary = chunk
    return gltf, binary


def write_glb(path, gltf, binary):
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)  # chunks are 4-byte aligned; JSON pads with spaces, BIN with nulls
    binary += b"\x00" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + (8 + len(binary) if binary else 0)
    out = b"glTF" + struct.pack("<II", 2, total) + struct.pack("<II", len(js), JSON_CHUNK) + js
    if binary:
        out += struct.pack("<II", len(binary), BIN_CHUNK) + binary
    open(path, "wb").write(out)


def externalize(name):
    path = f"{DIR}/{name}.glb"
    gltf, binary = read_glb(path)
    images = gltf.get("images", [])
    if not images or all("bufferView" not in image for image in images):
        print(f"{name}.glb: already externalized")
        return

    os.makedirs(TEX_DIR, exist_ok=True)
    image_views = {image["bufferView"] for image in images if "bufferView" in image}
    for image in images:
        view = gltf["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        file_name = f"{image['name']}.{EXTENSIONS[image['mimeType']]}"
        open(f"{TEX_DIR}/{file_name}", "wb").write(binary[start : start + view["byteLength"]])
        del image["bufferView"]
        del image["mimeType"]  # inferred from the file extension once external
        image["uri"] = URI_PREFIX + file_name

    # Repack the buffer without the image bytes, keeping every other view 4-byte aligned.
    packed, remap, views = bytearray(), {}, []
    for index, view in enumerate(gltf["bufferViews"]):
        if index in image_views:
            continue
        start = view.get("byteOffset", 0)
        packed += b"\x00" * (-len(packed) % 4)
        moved = dict(view)
        moved["byteOffset"] = len(packed)
        packed += binary[start : start + view["byteLength"]]
        remap[index] = len(views)
        views.append(moved)

    gltf["bufferViews"] = views
    for accessor in gltf.get("accessors", []):
        if "bufferView" in accessor:
            accessor["bufferView"] = remap[accessor["bufferView"]]
    gltf["buffers"] = [{"byteLength": len(packed)}]

    before = os.path.getsize(path)
    write_glb(path, gltf, bytes(packed))
    print(f"{name}.glb: {before / 1024:.1f}KB -> {os.path.getsize(path) / 1024:.1f}KB")


for target in TARGETS:
    externalize(target)

shared = sum(os.path.getsize(f"{TEX_DIR}/{f}") for f in os.listdir(TEX_DIR))
print(f"shared textures: {shared / 1024:.1f}KB")
