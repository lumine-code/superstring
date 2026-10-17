#include "change-wrapper.h"
#include "addon-data.h"
#include "point-wrapper.h"
#include "string-conversion.h"
#include <sstream>

using namespace Napi;
static const napi_type_tag ChangeTag = {0xf280a1b59a5b49c5, 0x8f44a6507e7168c1};

void ChangeWrapper::init(Napi::Env env) {
  auto constructor = DefineClass(env, "Change", {
    InstanceMethod<&ChangeWrapper::to_string>("toString"),
  });
  env.GetInstanceData<AddonData>()->change_wrapper_constructor = Persistent(constructor);
}

Value ChangeWrapper::from_change(Napi::Env env, const Patch::Change &change) {
  return from_owned_change(env, {
    change.old_start, change.old_end, change.new_start, change.new_end,
    change.old_text ? std::make_shared<const Text>(*change.old_text) : nullptr,
    change.new_text ? std::make_shared<const Text>(*change.new_text) : nullptr,
    change.preceding_old_text_size, change.preceding_new_text_size, change.old_text_size
  });
}

Value ChangeWrapper::from_owned_change(Napi::Env env, Patch::OwnedChange change) {
  return env.GetInstanceData<AddonData>()->change_wrapper_constructor.New({
    External<Patch::OwnedChange>::New(env, &change)
  });
}

ChangeWrapper *ChangeWrapper::from_js(Napi::Value value) {
  if (!value.IsObject() || !value.As<Object>().CheckTypeTag(&ChangeTag)) {
    TypeError::New(value.Env(), "Expected a native patch change").ThrowAsJavaScriptException();
    return nullptr;
  }
  return Unwrap(value.As<Object>());
}

ChangeWrapper::ChangeWrapper(const CallbackInfo &info) : ObjectWrap(info) {
  if (!info[0].IsExternal()) {
    TypeError::New(info.Env(), "Changes are created by Patch").ThrowAsJavaScriptException();
    return;
  }
  change = std::move(*info[0].As<External<Patch::OwnedChange>>().Data());
  auto object = info.This().As<Object>();
  object.TypeTag(&ChangeTag);
  object.Set("oldStart", PointWrapper::from_point(info.Env(), change.old_start));
  object.Set("oldEnd", PointWrapper::from_point(info.Env(), change.old_end));
  object.Set("newStart", PointWrapper::from_point(info.Env(), change.new_start));
  object.Set("newEnd", PointWrapper::from_point(info.Env(), change.new_end));
  if (change.new_text && change.old_text) {
    // Preserve UTF-16 code units. Object::Set<Napi::String> can select the
    // implicit UTF-8 conversion and replace unpaired surrogates.
    object.Set("oldText", static_cast<napi_value>(string_conversion::string_to_js(info.Env(), change.old_text->content)));
    object.Set("newText", static_cast<napi_value>(string_conversion::string_to_js(info.Env(), change.new_text->content)));
  }
  for (auto name : {"oldStart", "oldEnd", "newStart", "newEnd"}) object.Get(name).As<Object>().Freeze();
  object.Freeze();
}

Value ChangeWrapper::to_string(const CallbackInfo &info) {
  std::stringstream output;
  output << Patch::Change{change.old_start, change.old_end, change.new_start, change.new_end,
    change.old_text.get(), change.new_text.get(), change.preceding_old_text_size,
    change.preceding_new_text_size, change.old_text_size};
  return String::New(info.Env(), output.str());
}
