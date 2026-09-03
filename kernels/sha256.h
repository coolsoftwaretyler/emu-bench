/* sha256.h — minimal SHA-256 (FIPS 180-4), public domain style.
 *
 * Written directly from the FIPS 180-4 specification for kernels/main.c's
 * "SHA-256 over 1 GB" benchmark (PLAN.md §4 Group 1, SPEC.md §8). No
 * external dependencies beyond libc; C11; single translation unit pair
 * (sha256.h / sha256.c) so the Makefile's three targets can compile it
 * identically alongside main.c.
 */

#ifndef EMBENCH_SHA256_H
#define EMBENCH_SHA256_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint32_t state[8];
    uint64_t bitlen;
    uint8_t buffer[64];
    size_t buffer_len;
} sha256_ctx;

void sha256_init(sha256_ctx *ctx);
void sha256_update(sha256_ctx *ctx, const uint8_t *data, size_t len);
void sha256_final(sha256_ctx *ctx, uint8_t digest[32]);

#endif /* EMBENCH_SHA256_H */
