CLANG     ?= clang
BPFTOOL   ?= bpftool
ARCH      := $(shell uname -m | sed 's/x86_64/x86/; s/aarch64/arm64/; s/armv7l/arm/; s/ppc64le/powerpc/; s/mips.*/mips/')

VMLINUX   := include/vmlinux.h
OBJ       := bin/blktop.bpf.o
SRC       := blktop.bpf.c

BPF_CFLAGS := -O2 -g -Wall -Werror -target bpf -D__TARGET_ARCH_$(ARCH) \
              -Iinclude -I/usr/include

.PHONY: all clean

all: $(OBJ)

$(VMLINUX):
	@mkdir -p $(@D)
	$(BPFTOOL) btf dump file /sys/kernel/btf/vmlinux format c > $@

$(OBJ): $(SRC) $(VMLINUX)
	@mkdir -p $(@D)
	$(CLANG) $(BPF_CFLAGS) -c $(SRC) -o $@

clean:
	rm -rf bin include
