// Web shim for libdispatch, used only so Photoshop.eth's original C kernels compile to WebAssembly unchanged.
// WebAssembly here runs single-threaded, so dispatch_apply runs its iterations in order on the calling thread.
#ifndef COMPOSITOR_WEB_DISPATCH_SHIM_H
#define COMPOSITOR_WEB_DISPATCH_SHIM_H
#include <stddef.h>
#define DISPATCH_APPLY_AUTO ((void *)0)
static inline void dispatch_apply(size_t iterations, void *queue, void (^block)(size_t)) {
    (void)queue;
    for (size_t i = 0; i < iterations; i++) block(i);
}
#endif
