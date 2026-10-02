#include "marker-index.h"
#include <catch_amalgamated.hpp>

static void require_no_invalidation(const MarkerIndex::SpliceResult &result) {
  REQUIRE(result.touch.size() == 0);
  REQUIRE(result.inside.size() == 0);
  REQUIRE(result.overlap.size() == 0);
  REQUIRE(result.surround.size() == 0);
}

TEST_CASE("MarkerIndex::find_intersecting preserves complete queries after edits and removals") {
  MarkerIndex index(7);
  index.insert(UINT32_MAX, Point(2, 0), Point(2, 0));
  index.insert(31, Point(), Point(10, 3));
  index.insert(0, Point(1, 2), Point(1, 2));
  index.insert(8, Point(1, 2), Point(1, 2));
  index.insert(99, Point(12, 0), Point(12, 0));
  index.set_exclusive(8, true);
  auto query = [&](Point start, Point end) {
    const auto found = index.find_intersecting(start, end);
    return std::vector<MarkerIndex::MarkerId>(found.begin(), found.end());
  };
  const std::vector<MarkerIndex::MarkerId> all{0, 8, 31, 99, UINT32_MAX};
  REQUIRE(query(Point(), Point(12, 0)) == all);
  REQUIRE(query(Point(), Point::max()) == all);
  REQUIRE(query(Point(), Point(10, 3)) == std::vector<MarkerIndex::MarkerId>({0, 8, 31, UINT32_MAX}));
  REQUIRE(query(Point(2, 0), Point::max()) == std::vector<MarkerIndex::MarkerId>({31, 99, UINT32_MAX}));

  index.splice(Point(1, 2), Point(), Point(0, 3));
  REQUIRE(index.get_start(0) == Point(1, 2));
  REQUIRE(index.get_end(0) == Point(1, 5));
  REQUIRE(index.get_start(8) == Point(1, 5));
  REQUIRE(index.get_end(8) == Point(1, 5));
  REQUIRE(query(Point(), Point(12, 0)) == all);
  index.remove(31);
  index.splice(Point(1, 0), Point(1, 0), Point());
  for (unsigned id : {0u, 8u, UINT32_MAX}) {
    REQUIRE(index.get_start(id) == Point(1, 0));
    REQUIRE(index.get_end(id) == Point(1, 0));
  }
  const std::vector<MarkerIndex::MarkerId> remaining{0, 8, 99, UINT32_MAX};
  REQUIRE(query(Point(), Point(11, 0)) == remaining);
  REQUIRE(query(Point(), Point::max()) == remaining);
  for (unsigned id : remaining) index.remove(id);
  REQUIRE(query(Point(), Point::max()).empty());
}

TEST_CASE("MarkerIndex::find_intersecting preserves duplicate-ID endpoint visibility") {
  for (unsigned scenario = 0; scenario < 3; scenario++) {
    MarkerIndex index(1);
    index.insert(7, Point(1, 0), Point(5, 0));
    index.insert(7, Point(scenario == 0 ? 1 : 3, 0), Point(scenario == 1 ? 5 : 9, 0));
    index.remove(7);
    REQUIRE(!index.has(7));
    const auto ghost = index.find_intersecting(Point(), Point::max());
    REQUIRE(std::vector<MarkerIndex::MarkerId>(ghost.begin(), ghost.end()) == std::vector<MarkerIndex::MarkerId>({7}));
    index.insert(7, Point(), Point(2, 0));
    index.remove(7);
    index.insert(UINT32_MAX, Point(12, 0), Point(12, 0));
    const auto found = index.find_intersecting(Point(), Point(12, 0));
    REQUIRE(std::vector<MarkerIndex::MarkerId>(found.begin(), found.end()) == std::vector<MarkerIndex::MarkerId>({7, UINT32_MAX}));
  }
}

TEST_CASE("MarkerIndex::find_intersecting preserves finite bounds after row saturation") {
  MarkerIndex index(0);
  index.insert(0, Point(), Point());
  index.insert(1, Point(UINT32_MAX - 1, 30), Point(UINT32_MAX - 1, 30));
  index.insert(2, Point(UINT32_MAX, 0), Point(UINT32_MAX, 0));
  index.splice(Point(), Point(), Point(1, 0));
  // Tree order can put (MAX,30) before (MAX,0) after saturated arithmetic.
  const auto finite = index.find_intersecting(Point(), Point(UINT32_MAX, 0));
  REQUIRE(std::vector<MarkerIndex::MarkerId>(finite.begin(), finite.end()) == std::vector<MarkerIndex::MarkerId>({0}));
  const auto unbounded = index.find_intersecting(Point(), Point::max());
  REQUIRE(std::vector<MarkerIndex::MarkerId>(unbounded.begin(), unbounded.end()) == std::vector<MarkerIndex::MarkerId>({0, 1, 2}));
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
