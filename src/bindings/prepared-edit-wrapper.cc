#include "prepared-edit-wrapper.h"
#include "addon-data.h"
#include "text-buffer-wrapper.h"
#include "patch-wrapper.h"
#include "point-wrapper.h"
#include "string-conversion.h"

using namespace Napi;

void PreparedEditWrapper::init(Napi::Env env) {
  auto constructor = DefineClass(env, "PreparedEdit", {
    InstanceMethod<&PreparedEditWrapper::get_change>("getChange"),
    InstanceMethod<&PreparedEditWrapper::create_patch>("createPatch"),
    InstanceMethod<&PreparedEditWrapper::commit>("commit"),
    InstanceMethod<&PreparedEditWrapper::dispose>("dispose"),
  });
  env.GetInstanceData<AddonData>()->prepared_edit_constructor = Persistent(constructor);
}

Value PreparedEditWrapper::create(Napi::Object owner, Range range, Patch::SharedText old_text,
                                  Patch::SharedText new_text, Napi::Value old_value, Napi::Value new_value) {
  Input input{range, std::move(old_text), std::move(new_text)};
  return owner.Env().GetInstanceData<AddonData>()->prepared_edit_constructor.New({
    owner, External<Input>::New(owner.Env(), &input), old_value, new_value
  });
}

PreparedEditWrapper::PreparedEditWrapper(const CallbackInfo &info) : ObjectWrap(info) {
  if (!info[0].IsObject() || !info[1].IsExternal()) {
    TypeError::New(info.Env(), "Prepared edits are created by TextBuffer").ThrowAsJavaScriptException();
    return;
  }
  auto object = info[0].As<Object>();
  owner = Persistent(object);
  buffer = TextBufferWrapper::Unwrap(object);
  input = std::move(*info[1].As<External<Input>>().Data());
  revision = buffer->text_buffer.revision();
  auto start_index = buffer->text_buffer.clip_position(input.range.start).offset;
  auto change = Object::New(info.Env());
  change.Set("oldStart", PointWrapper::from_point(info.Env(), input.range.start));
  change.Set("oldEnd", PointWrapper::from_point(info.Env(), input.range.end));
  change.Set("newStart", PointWrapper::from_point(info.Env(), input.range.start));
  change.Set("newEnd", PointWrapper::from_point(info.Env(), input.range.start.traverse(input.new_text->extent())));
  change.Set("oldText", info[2].IsUndefined() ? string_conversion::string_to_js(info.Env(), input.old_text->content) : info[2]);
  change.Set("newText", info[3]);
  change.Set("startIndex", Number::New(info.Env(), start_index));
  change.Set("oldEndIndex", Number::New(info.Env(), static_cast<double>(start_index) + input.old_text->size()));
  change.Set("newEndIndex", Number::New(info.Env(), static_cast<double>(start_index) + input.new_text->size()));
  if (info.Env().IsExceptionPending()) { release(); return; }
  for (auto name : {"oldStart", "oldEnd", "newStart", "newEnd"}) change.Get(name).As<Object>().Freeze();
  change.Freeze();
  metadata = Persistent(change);
}

bool PreparedEditWrapper::check_active() {
  if (active) return true;
  Error::New(Env(), "Prepared edit is already committed or disposed").ThrowAsJavaScriptException();
  return false;
}

void PreparedEditWrapper::release() {
  active = false;
  input.old_text.reset();
  input.new_text.reset();
  buffer = nullptr;
  metadata.Reset();
  owner.Reset();
}

Value PreparedEditWrapper::get_change(const CallbackInfo &info) {
  if (!check_active()) return info.Env().Undefined();
  return metadata.Value();
}

Value PreparedEditWrapper::create_patch(const CallbackInfo &info) {
  if (!check_active()) return info.Env().Undefined();
  Patch patch;
  patch.splice_shared(input.range.start, input.range.extent(), input.new_text->extent(),
    input.old_text, input.new_text);
  return PatchWrapper::from_patch(info.Env(), std::move(patch));
}

void PreparedEditWrapper::commit(const CallbackInfo &info) {
  if (!check_active()) return;
  if (buffer->text_buffer.revision() != revision) {
    release();
    auto error = Error::New(info.Env(), "Prepared edit no longer matches the buffer revision");
    error.Set("code", "ERR_STALE_EDIT");
    error.ThrowAsJavaScriptException();
    return;
  }
  buffer->cancel_queued_workers();
  if (input.range.start == Point() && input.range.end == buffer->text_buffer.extent()) {
    buffer->text_buffer.set_shared_text(input.new_text);
  } else {
    buffer->text_buffer.set_shared_text_in_range(input.range, input.new_text);
  }
  release();
}

void PreparedEditWrapper::dispose(const CallbackInfo &) { release(); }
