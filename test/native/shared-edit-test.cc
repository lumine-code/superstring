#include "test-helpers.h"
#include "text-buffer.h"
#include "text-slice.h"

TEST_CASE("Shared edits reuse immutable text through buffer and history") {
  auto old_text = std::make_shared<const Text>(u"");
  auto new_text = std::make_shared<const Text>(u"inserted\ntext");
  std::weak_ptr<const Text> lifetime = new_text;
  {
    TextBuffer buffer{u"prefix\nsuffix"};
    std::unique_ptr<TextBuffer::Snapshot> snapshot{buffer.create_snapshot()};
    Patch history;
    REQUIRE(history.splice_shared(Point(1, 0), Point(), new_text->extent(), old_text, new_text));
    buffer.set_shared_text_in_range({Point(1, 0), Point(1, 0)}, new_text);
    auto copied = history.copy();
    auto inverted = history.invert();
    Patch composed;
    REQUIRE(composed.combine(history));
    REQUIRE(history.get_changes()[0].new_text == new_text.get());
    REQUIRE(copied.get_changes()[0].new_text == new_text.get());
    REQUIRE(inverted.get_changes()[0].old_text == new_text.get());
    REQUIRE(composed.get_changes()[0].new_text == new_text.get());
    bool buffer_shares_input = false;
    for (auto chunk : buffer.chunks()) {
      if (chunk.text == new_text.get()) buffer_shares_input = true;
    }
    REQUIRE(buffer_shares_input);
    buffer.set_text_in_range({Point(1, 0), Point(1, 1)}, u"X");
    REQUIRE(snapshot->text() == u"prefix\nsuffix");
    REQUIRE(copied.get_changes()[0].new_text->content == u"inserted\ntext");
    REQUIRE(new_text->content == u"inserted\ntext");
    new_text.reset();
    REQUIRE_FALSE(lifetime.expired());
  }
  REQUIRE(lifetime.expired());
}

TEST_CASE("Shared patch splice_old creates independent concatenated text") {
  Patch patch;
  REQUIRE(patch.splice(Point(0, 1), Point(0, 1), Point(0, 1), Text{u"b"}, Text{u"B"}));
  REQUIRE(patch.splice(Point(0, 3), Point(0, 1), Point(0, 1), Text{u"d"}, Text{u"D"}));
  auto copied = patch.copy();
  patch.splice_old(Point(0, 2), Point(0, 1), Point());
  REQUIRE(copied.get_changes().size() == 2);
  REQUIRE(copied.get_changes()[0].new_text->content == u"B");
  REQUIRE(copied.get_changes()[1].new_text->content == u"D");
}
