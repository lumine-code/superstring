#ifndef SUPERSTRING_CHANGE_WRAPPER_H_
#define SUPERSTRING_CHANGE_WRAPPER_H_

#include "napi.h"
#include "patch.h"

// JS change snapshots own their payload. Internal spatial reads still borrow it.
class ChangeWrapper : public Napi::ObjectWrap<ChangeWrapper> {
public:
  static void init(Napi::Env);
  static Napi::Value from_change(Napi::Env, const Patch::Change &);
  static Napi::Value from_owned_change(Napi::Env, Patch::OwnedChange);
  static ChangeWrapper *from_js(Napi::Value);
  explicit ChangeWrapper(const Napi::CallbackInfo &);
  Patch::OwnedChange change;

private:
  Napi::Value to_string(const Napi::CallbackInfo &);
};

#endif
