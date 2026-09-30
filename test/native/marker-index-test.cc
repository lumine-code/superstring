#include "marker-index.h"
#include <catch_amalgamated.hpp>

static void require_no_invalidation(const MarkerIndex::SpliceResult &result) {
  REQUIRE(result.touch.size() == 0);
  REQUIRE(result.inside.size() == 0);
  REQUIRE(result.overlap.size() == 0);
  REQUIRE(result.surround.size() == 0);
}

TEST_CASE("MarkerIndex::splice preserves disjoint equal-extent ranges across later edits") {
  MarkerIndex index(7);
  index.insert(1, Point(0, 10), Point(0, 20));
  index.insert(2, Point(0, 40), Point(0, 50));
  index.insert(3, Point(0, 70), Point(0, 70));
  index.set_exclusive(2, true);
  index.set_exclusive(3, true);
  const auto before = index.dump();

  for (unsigned iteration = 0; iteration < 50; iteration++) {
    for (unsigned column : {1u, 30u, 80u}) {
      for (unsigned id : {1u, 2u, 3u}) index.get_range(id);
      require_no_invalidation(index.splice(Point(0, column), Point(0, 2), Point(0, 2)));
      REQUIRE(index.dump() == before);
      REQUIRE(index.find_intersecting(Point(0, 10), Point(0, 50)).size() == 2);
    }
  }

  require_no_invalidation(index.splice(Point(), Point(), Point(0, 3)));
  REQUIRE(index.get_start(1) == Point(0, 13));
  REQUIRE(index.get_end(1) == Point(0, 23));
  REQUIRE(index.get_start(2) == Point(0, 43));
  REQUIRE(index.get_end(2) == Point(0, 53));
  REQUIRE(index.get_start(3) == Point(0, 73));
  REQUIRE(index.get_end(3) == Point(0, 73));
  index.remove(2);
  index.insert(4, Point(0, 25), Point(0, 28));
  const auto touched = index.splice(Point(0, 26), Point(0, 1), Point(0, 1));
  REQUIRE(touched.touch.size() == 1);
  REQUIRE(touched.touch.count(4) == 1);
  REQUIRE(index.get_start(4) == Point(0, 25));
  REQUIRE(index.get_end(4) == Point(0, 28));
}

TEST_CASE("MarkerIndex::splice retains closed boundary and empty-marker invalidation") {
  for (bool exclusive : {false, true}) {
    for (bool empty : {false, true}) {
      for (bool touch_start : {false, true}) {
        MarkerIndex index(3);
        const Point start(0, 10);
        const Point end(0, empty ? 10 : 20);
        index.insert(1, start, end);
        index.set_exclusive(1, exclusive);
        const Point splice_start = touch_start ? Point(0, 8) : end;
        const auto result = index.splice(splice_start, Point(0, 2), Point(0, 2));
        REQUIRE(result.touch.size() == 1);
        REQUIRE(result.touch.count(1) == 1);
        REQUIRE(result.overlap.size() == 0);
        REQUIRE(result.surround.size() == 0);
      }
    }
  }
}

TEST_CASE("MarkerIndex::splice preserves a single marker for disjoint equal-extent edits") {
  for (bool exclusive : {false, true}) {
    MarkerIndex index(7);
    index.insert(1, Point(0, 10), Point(0, 20));
    index.set_exclusive(1, exclusive);
    for (unsigned iteration = 0; iteration < 50; iteration++) {
      for (unsigned column : {1u, 30u}) {
        require_no_invalidation(index.splice(Point(0, column), Point(0, 2), Point(0, 2)));
        REQUIRE(index.get_start(1) == Point(0, 10));
        REQUIRE(index.get_end(1) == Point(0, 20));
      }
    }
    require_no_invalidation(index.splice(Point(), Point(), Point(0, 3)));
    REQUIRE(index.get_start(1) == Point(0, 13));
    REQUIRE(index.get_end(1) == Point(0, 23));
    require_no_invalidation(index.splice(Point(0, 1), Point(0, 2), Point(0, 2)));
    REQUIRE(index.get_start(1) == Point(0, 13));
    REQUIRE(index.get_end(1) == Point(0, 23));
  }
}

TEST_CASE("MarkerIndex::splice invalidates an enclosing marker without endpoints in the splice") {
  MarkerIndex index(8);
  index.insert(1, Point(), Point(0, 100));
  const auto result = index.splice(Point(0, 40), Point(0, 2), Point(0, 2));
  REQUIRE(result.touch.size() == 1);
  REQUIRE(result.touch.count(1) == 1);
  REQUIRE(result.inside.size() == 1);
  REQUIRE(result.inside.count(1) == 1);
  REQUIRE(result.overlap.size() == 0);
  REQUIRE(result.surround.size() == 0);
}

TEST_CASE("MarkerIndex::splice compares both dimensions of multiline extents") {
  MarkerIndex index(2);
  index.insert(1, Point(5, 3), Point(6, 4));
  require_no_invalidation(index.splice(Point(0, 4), Point(1, 2), Point(1, 2)));
  REQUIRE(index.get_start(1) == Point(5, 3));
  REQUIRE(index.get_end(1) == Point(6, 4));
  require_no_invalidation(index.splice(Point(0, 4), Point(1, 2), Point(0, 2)));
  REQUIRE(index.get_start(1) == Point(4, 3));
  REQUIRE(index.get_end(1) == Point(5, 4));
}

TEST_CASE("MarkerIndex::splice retains historical reversed-range handling") {
  MarkerIndex index(1);
  index.insert(1, Point(0, 20), Point(0, 10));
  for (unsigned column : {1u, 14u, 25u}) {
    require_no_invalidation(index.splice(Point(0, column), Point(0, 2), Point(0, 2)));
    REQUIRE(index.get_start(1) == Point(0, 20));
    REQUIRE(index.get_end(1) == Point(0, 10));
  }
}

TEST_CASE("MarkerIndex::splice preserves maximum endpoints and saturation semantics") {
  MarkerIndex index(2);
  index.insert(1, Point(10, 0), Point::max());
  require_no_invalidation(index.splice(Point(0, 1), Point(0, 2), Point(0, 2)));
  REQUIRE(index.get_start(1) == Point(10, 0));
  REQUIRE(index.get_end(1) == Point::max());
  const auto interior = index.splice(Point(20, 1), Point(0, 2), Point(0, 2));
  REQUIRE(interior.touch.count(1) == 1);
  REQUIRE(interior.inside.count(1) == 1);
  const auto boundary = index.splice(Point(UINT32_MAX, UINT32_MAX - 1), Point(0, 1), Point(0, 1));
  REQUIRE(boundary.touch.count(1) == 1);
  REQUIRE(index.get_start(1) == Point(10, 0));
  REQUIRE(index.get_end(1) == Point::max());
}
