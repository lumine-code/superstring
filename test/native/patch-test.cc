#include "test-helpers.h"

using Change = Patch::Change;
using std::vector;

static optional<Text> null_text;

TEST_CASE("Patch::splice - owns large multiline text after input lifetimes end") {
  std::u16string old_content, new_content;
  for (size_t i = 0; i < 16384; i++) {
    old_content += u"old \u03a9 \U0001f680\r\n";
    new_content += u"new \u03bb \U0001f30d\r\n";
  }
  old_content += u"end";
  new_content += u"end";
  const Text expected_old{old_content};
  const Text expected_new{new_content};
  const Point extent = expected_new.extent();
  REQUIRE(expected_old.extent() == extent);
  const uint32_t row_step = extent.row + 3;
  Patch patch;

  auto splice_with_local_inputs = [&](Point start, bool insertion) {
    optional<Text> deleted{insertion ? Text{u""} : Text{old_content}};
    optional<Text> inserted{Text{new_content}};
    REQUIRE(patch.splice(start, insertion ? Point() : extent, extent,
                         std::move(deleted), std::move(inserted)));
    // Reusing and destroying the caller's inputs must leave the patch intact.
    *deleted = Text{u"reused old input"};
    *inserted = Text{u"reused new input"};
  };

  // New nodes are added after, before and between existing changes.
  for (uint32_t row : {2 * row_step, 4 * row_step, 0u, row_step}) {
    splice_with_local_inputs(Point(row, 0), false);
  }
  splice_with_local_inputs(Point(5 * row_step, 0), true);

  const auto expected_changes = patch.get_changes();
  REQUIRE(expected_changes.size() == 5);
  const vector<uint32_t> rows{0, row_step, 2 * row_step, 4 * row_step, 5 * row_step};
  for (size_t i = 0; i < expected_changes.size(); i++) {
    const auto &change = expected_changes[i];
    REQUIRE(change.old_start == Point(rows[i], 0));
    REQUIRE(change.new_start == Point(rows[i], 0));
    REQUIRE(change.old_end == Point(rows[i], 0).traverse(i == 4 ? Point() : extent));
    REQUIRE(change.new_end == Point(rows[i], 0).traverse(extent));
    REQUIRE(*change.old_text == (i == 4 ? Text{u""} : expected_old));
    REQUIRE(*change.new_text == expected_new);
    REQUIRE(change.new_text->line_offsets == expected_new.line_offsets);
  }

  Patch copied = patch.copy();
  Patch inverted = patch.invert();
  vector<uint8_t> bytes;
  Serializer serializer{bytes};
  patch.serialize(serializer);
  Deserializer deserializer{bytes};
  Patch restored{deserializer};
  REQUIRE(copied.get_changes() == expected_changes);
  REQUIRE(restored.get_changes() == expected_changes);

  patch.clear();
  REQUIRE(patch.get_change_count() == 0);
  REQUIRE(copied.get_changes() == restored.get_changes());
  const auto copied_changes = copied.get_changes();
  const auto inverted_changes = inverted.get_changes();
  REQUIRE(inverted_changes.size() == copied_changes.size());
  for (size_t i = 0; i < copied_changes.size(); i++) {
    REQUIRE(*copied_changes[i].new_text == expected_new);
    REQUIRE(inverted_changes[i].old_start == copied_changes[i].new_start);
    REQUIRE(inverted_changes[i].old_end == copied_changes[i].new_end);
    REQUIRE(inverted_changes[i].new_start == copied_changes[i].old_start);
    REQUIRE(inverted_changes[i].new_end == copied_changes[i].old_end);
    REQUIRE(*inverted_changes[i].old_text == *copied_changes[i].new_text);
    REQUIRE(*inverted_changes[i].new_text == *copied_changes[i].old_text);
    REQUIRE(inverted_changes[i].old_text->line_offsets == expected_new.line_offsets);
  }
}

TEST_CASE("Patch::splice - rejects inconsistent prefixes without changing the patch") {
  for (bool has_later_change : {false, true}) {
    for (uint32_t column : {2u, 4u}) {
      Patch patch;
      REQUIRE(patch.splice(Point(0, 0), Point(0, 1), Point(2, 0), Text(u"x"), Text(u"a\n\n")));
      if (has_later_change) {
        REQUIRE(patch.splice(Point(4, 0), Point(0, 1), Point(0, 1), Text(u"y"), Text(u"z")));
      }
      Patch before = patch.copy();
      Point deletion_extent(has_later_change ? 3 : 1, 0);
      Text deleted_text(has_later_change ? u"\n\n\n" : u"\n");

      REQUIRE(!patch.splice(Point(0, column), deletion_extent, Point(0, 1),
                            std::move(deleted_text), Text(u"b")));
      REQUIRE(patch.get_changes() == before.get_changes());

      REQUIRE(patch.splice(Point(0, 1), Point(0, 0), Point(0, 1), Text(u""), Text(u"c")));
      REQUIRE(*patch.get_changes().front().new_text == Text(u"ac\n\n"));
    }
  }
}

TEST_CASE("Patch::splice – simple non-overlapping") {
  Patch patch;

  patch.splice(Point {0, 5}, Point {0, 3}, Point {0, 4});
  patch.splice(Point {0, 10}, Point {0, 3}, Point {0, 4});
  REQUIRE(patch.get_changes() == vector<Change>({
    Change {
      Point {0, 5}, Point {0, 8},
      Point {0, 5}, Point {0, 9},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 9}, Point {0, 12},
      Point {0, 10}, Point {0, 14},
      nullptr, nullptr,
      0, 0, 0
    }
  }));

  patch.splice(Point {0, 2}, Point {0, 2}, Point {0, 1});
  REQUIRE(patch.get_changes() == vector<Change>({
    Change {
      Point {0, 2}, Point {0, 4},
      Point {0, 2}, Point {0, 3},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 5}, Point {0, 8},
      Point {0, 4}, Point {0, 8},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 9}, Point {0, 12},
      Point {0, 9}, Point {0, 13},
      nullptr, nullptr,
      0, 0, 0
    }
  }));

  patch.splice(Point {0, 0}, Point {0, 0}, Point {0, 10});
  REQUIRE(patch.get_changes() == vector<Change>({
    Change {
      Point {0, 0}, Point {0, 0},
      Point {0, 0}, Point {0, 10},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 2}, Point {0, 4},
      Point {0, 12}, Point {0, 13},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 5}, Point {0, 8},
      Point {0, 14}, Point {0, 18},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 9}, Point {0, 12},
      Point {0, 19}, Point {0, 23},
      nullptr, nullptr,
      0, 0, 0
    }
  }));
}

TEST_CASE("Patch::splice - overlapping with text") {
  Patch patch;

  patch.splice(
    Point {0, 5},
    Point {0, 3},
    Point {0, 4},
    Text {u"abc"},
    Text {u"1234"}
  );
  REQUIRE(patch.get_changes() == vector<Change>({
    Change {
      Point {0, 5}, Point {0, 8},
      Point {0, 5}, Point {0, 9},
      get_text(u"abc").get(),
      get_text(u"1234").get(),
      0, 0, 0
    },
  }));

  // overlaps lower bound, has no upper bound.
  patch.splice(
    Point {0, 7},
    Point {0, 3},
    Point {0, 4},
    Text {u"34d"},
    Text {u"5678"}
  );
  REQUIRE(patch.get_changes() == vector<Change>({
    Change {
      Point {0, 5}, Point {0, 9},
      Point {0, 5}, Point {0, 11},
      get_text(u"abcd").get(),
      get_text(u"125678").get(),
      0, 0, 0
    },
  }));

  // overlaps upper bound, has no lower bound.
  patch.splice(
    Point {0, 3},
    Point {0, 3},
    Point {0, 4},
    Text {u"efa"},
    Text {u"1234"}
  );
  REQUIRE(patch.get_changes() == vector<Change>({
    {
      Point {0, 3}, Point {0, 9},
      Point {0, 3}, Point {0, 12},
      get_text(u"efabcd").get(),
      get_text(u"123425678").get(),
      0, 0, 0
    },
  }));

  // doesn't overlap lower bound, has no upper bound
  patch.splice(
    Point {0, 15},
    Point {0, 3},
    Point {0, 4},
    Text {u"ghi"},
    Text {u"5678"}
  );
  REQUIRE(patch.get_changes() == vector<Change>({
    Change {
      Point {0, 3}, Point {0, 9},
      Point {0, 3}, Point {0, 12},
      get_text(u"efabcd").get(),
      get_text(u"123425678").get(),
      0, 0, 0
    },
    Change {
      Point {0, 12}, Point {0, 15},
      Point {0, 15}, Point {0, 19},
      get_text(u"ghi").get(),
      get_text(u"5678").get(),
      6, 9, 0
    },
  }));

  // surrounds two changes, has no lower or upper bound
  patch.splice(
    Point {0, 1},
    Point {0, 21},
    Point {0, 5},
    Text {u"xx123425678yyy5678zzz"},
    Text {u"99999"}
  );
  REQUIRE(patch.get_changes() == vector<Change>({
    Change {
      Point {0, 1}, Point {0, 18},
      Point {0, 1}, Point {0, 6},
      get_text(u"xxefabcdyyyghizzz").get(),
      get_text(u"99999").get(),
      0, 0, 0
    }
  }));
}

TEST_CASE("Patch::splice - deleted_text_size") {
  Patch patch;

  patch.splice(Point {0, 2}, Point {0, 3}, Point {0, 5}, optional<Text> {}, Text {u"xxxxx"}, 3);
  patch.splice(Point {1, 0}, Point {0, 0}, Point {0, 1}, optional<Text> {}, Text {u"x"}, 0);
  REQUIRE(patch.get_changes().back().preceding_old_text_size == 3);

  patch.splice(Point {0, 1}, Point {0, 2}, Point {0, 5}, optional<Text> {}, Text {u"xxxxx"}, 2);
  REQUIRE(patch.get_changes().back().preceding_old_text_size == 4);

  patch.splice(Point {0, 8}, Point {0, 4}, Point {0, 5}, optional<Text> {}, Text {u"xxxxx"}, 4);
  REQUIRE(patch.get_changes().back().preceding_old_text_size == 6);

  patch.splice(Point {0, 5}, Point {0, 3}, Point {0, 5}, optional<Text> {}, Text {u"xxxxx"}, 3);
  REQUIRE(patch.get_changes().back().preceding_old_text_size == 6);

  patch.splice(Point {0, 0}, Point {0, 16}, Point {0, 5}, optional<Text> {}, Text {u"xxxxx"}, 16);
  REQUIRE(patch.get_changes().back().preceding_old_text_size == 8);
}

TEST_CASE("Patch::splice - inconsistent old text") {
  Patch patch;
  auto result = patch.splice(Point{0, 0}, Point{0, 0}, Point{1, 4}, Text{u""}, Text{u"\n    "}, 0);
  REQUIRE(result == true);

  result = patch.splice(Point{1, 0}, Point{1, 0}, Point{0, 0}, Text{u"  \n"}, Text{u""}, 3);
  REQUIRE(result == false);
  REQUIRE(patch.get_changes() == vector<Patch::Change>({
    Change{
      Point{0, 0}, Point{0, 0},
      Point{0, 0}, Point{1, 4},
      get_text(u"").get(),
      get_text(u"\n    ").get(),
      0, 0, 0
    },
  }));
}

TEST_CASE("Patch::find_changes_in_new_range") {
  Patch patch;

  patch.splice(Point{0, 5}, Point{0, 3}, Point{0, 4});
  patch.splice(Point{0, 10}, Point{0, 3}, Point{0, 4});
  patch.splice(Point{0, 2}, Point{0, 2}, Point{0, 1});
  patch.splice(Point{0, 0}, Point{0, 0}, Point{0, 10});

  REQUIRE(patch.get_changes_in_new_range(Point{0, 12}, Point{0, 20}) == vector<Change>({
    Change {
      Point {0, 2}, Point {0, 4},
      Point {0, 12}, Point {0, 13},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 5}, Point {0, 8},
      Point {0, 14}, Point {0, 18},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 9}, Point {0, 12},
      Point {0, 19}, Point {0, 23},
      nullptr, nullptr,
      0, 0, 0
    }
  }));

  REQUIRE(patch.get_changes_in_new_range(Point{0, 12}, Point{0, 15}) == vector<Change>({
    Change {
      Point {0, 2}, Point {0, 4},
      Point {0, 12}, Point {0, 13},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 5}, Point {0, 8},
      Point {0, 14}, Point {0, 18},
      nullptr, nullptr,
      0, 0, 0
    },
  }));
}

TEST_CASE("Patch::serialize") {
  Patch patch;

  patch.splice(Point {0, 5}, Point {0, 3}, Point {0, 4});
  patch.splice(Point {0, 10}, Point {0, 3}, Point {0, 4});
  patch.splice(Point {0, 2}, Point {0, 2}, Point {0, 1});
  patch.splice(Point {0, 0}, Point {0, 0}, Point {0, 10});
  patch.grab_change_starting_before_old_position(Point {0, 5}); // splay the middle
  REQUIRE(patch.get_changes() == vector<Change>({
    Change {
      Point {0, 0}, Point {0, 0},
      Point {0, 0}, Point {0, 10},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 2}, Point {0, 4},
      Point {0, 12}, Point {0, 13},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 5}, Point {0, 8},
      Point {0, 14}, Point {0, 18},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 9}, Point {0, 12},
      Point {0, 19}, Point {0, 23},
      nullptr, nullptr,
      0, 0, 0
    }
  }));

  vector<uint8_t> bytes;
  Serializer serializer(bytes);
  patch.serialize(serializer);

  Deserializer deserializer(bytes);
  Patch patch_copy(deserializer);
  REQUIRE(patch_copy.get_changes() == vector<Change>({
    Change {
      Point {0, 0}, Point {0, 0},
      Point {0, 0}, Point {0, 10},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 2}, Point {0, 4},
      Point {0, 12}, Point {0, 13},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 5}, Point {0, 8},
      Point {0, 14}, Point {0, 18},
      nullptr, nullptr,
      0, 0, 0
    },
    Change {
      Point {0, 9}, Point {0, 12},
      Point {0, 19}, Point {0, 23},
      nullptr, nullptr,
      0, 0, 0
    }
  }));
}
