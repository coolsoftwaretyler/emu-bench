# kernels/Makefile — three-target build for the Group 1 C kernel suite
# (PLAN.md §4, SPEC.md §8, ticket T03). Identical source, three compilers,
# three environments: `make macos`, `make android`, `make iossim`. Built
# locally on the runner's machine every time — no prebuilt binaries ship
# in the repo (SPEC.md §8).
#
# -O2 everywhere, identical flags otherwise (ticket line 15), so the only
# variable across binaries is where each one runs.

SRCS := main.c sha256.c
CFLAGS_COMMON := -std=c11 -O2 -Wall -Wextra -Wpedantic

BUILD_DIR := build

# ---- macOS (leg A: run directly in a macOS terminal) -----------------

MACOS_DIR := $(BUILD_DIR)/macos
MACOS_BIN := $(MACOS_DIR)/embench-kernels

.PHONY: macos
macos: $(MACOS_BIN)

$(MACOS_BIN): $(SRCS) sha256.h
	@mkdir -p $(MACOS_DIR)
	clang $(CFLAGS_COMMON) $(SRCS) -lz -lpthread -o $(MACOS_BIN)

# ---- Android (leg B: adb push to /data/local/tmp, run via adb shell) --
#
# NDK clang, statically linked (ticket line 15: "-static"). NDK path from
# $NDK_HOME if set, else the newest version under
# $ANDROID_HOME/ndk/<ver> (SPEC.md §5 doctor table: NDK lives there).
# Static linking against bionic: plain libc + pthreads (pthread symbols
# are part of bionic's libc, not a separate archive) plus the NDK's
# per-API-level static libz.a (ticket "Risks": "zlib may need to be
# vendored... if libz static linking is awkward" — it isn't here, the NDK
# ships usr/lib/aarch64-linux-android/<api>/libz.a, so no vendoring
# needed).

# 35, not a legacy minimum: bench-tuned/bench-default (SPEC.md §6) both run
# the latest stable system image (android-37.0 on this machine), and lower
# API targets (tried: 24) produce a statically-linked libc.a whose PT_TLS
# segment is 8-byte aligned — recent bionic enforces >=64-byte TLS
# alignment and refuses to exec such a binary ("executable's TLS segment
# is underaligned"). Targeting API 35 links against a libc.a built with
# correct (64-byte) TLS alignment; confirmed empirically (llvm-readelf -l
# shows the fix, and the resulting binary runs via `adb shell` on a
# connected API-37 device).
ANDROID_API := 35
HOST_TAG := darwin-x86_64

ifdef NDK_HOME
  NDK_PATH := $(NDK_HOME)
else
  NDK_ROOT := $(if $(ANDROID_HOME),$(ANDROID_HOME)/ndk,$(HOME)/Library/Android/sdk/ndk)
  NDK_PATH := $(shell ls -d $(NDK_ROOT)/*/ 2>/dev/null | sort -V | tail -n1 | sed 's:/$$::')
endif

ANDROID_CLANG := $(NDK_PATH)/toolchains/llvm/prebuilt/$(HOST_TAG)/bin/aarch64-linux-android$(ANDROID_API)-clang
# libz.a (the static archive) lives directly under the arch sysroot dir,
# not per-API-level like libz.so does — the NDK doesn't version zlib's
# static archive per API level, only its dynamic stub.
ANDROID_SYSROOT_LIBZ := $(NDK_PATH)/toolchains/llvm/prebuilt/$(HOST_TAG)/sysroot/usr/lib/aarch64-linux-android/libz.a

ANDROID_DIR := $(BUILD_DIR)/android
ANDROID_BIN := $(ANDROID_DIR)/embench-kernels

.PHONY: android
android: $(ANDROID_BIN)

$(ANDROID_BIN): $(SRCS) sha256.h
	@if [ -z "$(NDK_PATH)" ] || [ ! -x "$(ANDROID_CLANG)" ]; then \
		echo "kernels/Makefile: NDK clang not found."; \
		echo "  Set NDK_HOME to an NDK root, or install one under \$$ANDROID_HOME/ndk/<version>"; \
		echo "  (tried: $(ANDROID_CLANG))"; \
		exit 1; \
	fi
	@mkdir -p $(ANDROID_DIR)
	# No -lpthread: bionic merged pthread symbols into libc itself years
	# ago, and modern NDKs no longer ship a separate libpthread archive to
	# link against (linking -lpthread here fails with "unable to find
	# library -lpthread").
	$(ANDROID_CLANG) $(CFLAGS_COMMON) -static $(SRCS) $(ANDROID_SYSROOT_LIBZ) -o $(ANDROID_BIN)

# ---- iOS Simulator (leg C: xcrun simctl spawn booted) ------------------

IOSSIM_DIR := $(BUILD_DIR)/iossim
IOSSIM_BIN := $(IOSSIM_DIR)/embench-kernels

.PHONY: iossim
iossim: $(IOSSIM_BIN)

$(IOSSIM_BIN): $(SRCS) sha256.h
	@mkdir -p $(IOSSIM_DIR)
	xcrun -sdk iphonesimulator clang -target arm64-apple-ios-simulator $(CFLAGS_COMMON) $(SRCS) -lz -lpthread -o $(IOSSIM_BIN)

# ---- fence round-trip probes (Group 4, ticket T08) ----------------------
#
# SPEC.md §10 native probes: two small CLI programs timing one
# submit→wait GPU lap, plus the same Metal loop built natively as the
# leg-A baseline so the result reports as a ratio like Group 1.
# `make fence` builds all three:
#   build/android/fence_android  — EGL/GLES2 glFinish loop (leg B, adb shell)
#   build/iossim/fence_iossim    — Metal waitUntilCompleted loop (leg C, simctl spawn)
#   build/macos/fence_macos      — the SAME fence_iossim.m source compiled as a
#                                  native macOS CLI (leg A), Group 1's
#                                  identical-source philosophy applied to Metal.
#
# ObjC flags: no -std=c11/-Wpedantic here — those are C-dialect flags and
# pedantic mode is noisy against the Metal framework headers; the fence
# probes keep -O2 -Wall -Wextra parity with the kernel suite.

OBJCFLAGS_COMMON := -O2 -Wall -Wextra -fobjc-arc
FENCE_FRAMEWORKS := -framework Metal -framework Foundation

FENCE_MACOS_BIN := $(MACOS_DIR)/fence_macos
FENCE_ANDROID_BIN := $(ANDROID_DIR)/fence_android
FENCE_IOSSIM_BIN := $(IOSSIM_DIR)/fence_iossim

.PHONY: fence fence-macos fence-android fence-iossim
fence: fence-macos fence-android fence-iossim
fence-macos: $(FENCE_MACOS_BIN)
fence-android: $(FENCE_ANDROID_BIN)
fence-iossim: $(FENCE_IOSSIM_BIN)

$(FENCE_MACOS_BIN): fence_iossim.m
	@mkdir -p $(MACOS_DIR)
	clang $(OBJCFLAGS_COMMON) fence_iossim.m $(FENCE_FRAMEWORKS) -o $(FENCE_MACOS_BIN)

# Unlike the kernel suite's -static build, the fence probe links
# dynamically: libEGL/libGLESv2 are shared system libraries on Android
# (there is nothing to statically link against), and NDK-built dynamic
# executables run fine from /data/local/tmp. -lm for the summary-line
# sqrt (bionic ships libm separately from libc).
$(FENCE_ANDROID_BIN): fence_android.c
	@if [ -z "$(NDK_PATH)" ] || [ ! -x "$(ANDROID_CLANG)" ]; then \
		echo "kernels/Makefile: NDK clang not found."; \
		echo "  Set NDK_HOME to an NDK root, or install one under \$$ANDROID_HOME/ndk/<version>"; \
		echo "  (tried: $(ANDROID_CLANG))"; \
		exit 1; \
	fi
	@mkdir -p $(ANDROID_DIR)
	$(ANDROID_CLANG) $(CFLAGS_COMMON) fence_android.c -lEGL -lGLESv2 -lm -o $(FENCE_ANDROID_BIN)

# The versioned triple (vs the kernel suite's bare arm64-apple-ios-simulator)
# matters for ARC: with no minimum OS version, clang assumes an ancient
# deployment target and demands libarclite, which modern Xcode no longer
# ships. iOS 15 is far below any runtime this suite targets (doctor
# installs the newest one, SPEC.md §5).
$(FENCE_IOSSIM_BIN): fence_iossim.m
	@mkdir -p $(IOSSIM_DIR)
	xcrun -sdk iphonesimulator clang -target arm64-apple-ios15.0-simulator $(OBJCFLAGS_COMMON) fence_iossim.m $(FENCE_FRAMEWORKS) -o $(FENCE_IOSSIM_BIN)

# ---- all / clean --------------------------------------------------------

.PHONY: all
all: macos android iossim fence

.PHONY: clean
clean:
	rm -rf $(BUILD_DIR)
