// Minimal Blocks runtime for WebAssembly. Photoshop.eth's DitherPixels.c uses Apple's blocks with dispatch_apply; the
// blocks there never outlive the call that makes them (they are never copied), so only the class symbols the
// compiler references and no-op copy helpers are needed.
#include <stddef.h>
void *_NSConcreteStackBlock[32];
void *_NSConcreteGlobalBlock[32];
void *_NSConcreteMallocBlock[32];
void _Block_object_assign(void *destination, const void *object, const int flags) {
    (void)flags; *(const void **)destination = object;
}
void _Block_object_dispose(const void *object, const int flags) { (void)object; (void)flags; }
void *_Block_copy(const void *block) { return (void *)block; }
void _Block_release(const void *block) { (void)block; }
