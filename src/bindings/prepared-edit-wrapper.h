#ifndef SUPERSTRING_PREPARED_EDIT_WRAPPER_H_
#define SUPERSTRING_PREPARED_EDIT_WRAPPER_H_

#include "napi.h"
#include "text-buffer.h"

class TextBufferWrapper;

// One immutable edit bound to the buffer generation at preparation time.
// commit consumes native resources; dispose also releases an uncommitted edit.
class PreparedEditWrapper : public Napi::ObjectWrap<PreparedEditWrapper> {
public:
  static void init(Napi::Env);
  static Napi::Value create(Napi::Object, Range, Patch::SharedText, Patch::SharedText,
                            Napi::Value old_text, Napi::Value new_text);
  explicit PreparedEditWrapper(const Napi::CallbackInfo &);

private:
  struct Input {
    Range range;
    Patch::SharedText old_text;
    Patch::SharedText new_text;
  };
  Napi::ObjectReference owner;
  Napi::ObjectReference metadata;
  TextBufferWrapper *buffer = nullptr;
  uint64_t revision = 0;
  Input input;
  bool active = true;

  bool check_active();
  void release();
  Napi::Value get_change(const Napi::CallbackInfo &);
  Napi::Value create_patch(const Napi::CallbackInfo &);
  void commit(const Napi::CallbackInfo &);
  void dispose(const Napi::CallbackInfo &);
};

#endif
