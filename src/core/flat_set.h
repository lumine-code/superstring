#ifndef SUPERSTRING_FLAT_SET_H
#define SUPERSTRING_FLAT_SET_H

#include <vector>
#include <algorithm>

template <typename T> class flat_set {
  typedef std::vector<T> contents_type;
  contents_type contents;

public:
  typedef typename contents_type::iterator iterator;
  typedef typename contents_type::const_iterator const_iterator;

  flat_set() = default;

  // Adopts `values`, sorting and de-duplicating them once. Building a large
  // set this way is O(k log k); building it with repeated insert() shifts the
  // vector tail on every insertion and degrades to O(k²).
  explicit flat_set(contents_type &&values) : contents{std::move(values)} {
    std::sort(contents.begin(), contents.end());
    contents.erase(std::unique(contents.begin(), contents.end()), contents.end());
  }

  void insert(T value) {
    auto iter = std::lower_bound(contents.begin(), contents.end(), value);
    if (iter == contents.end() || *iter != value) {
      contents.insert(iter, value);
    }
  }

  void insert(const_iterator start, const_iterator end) {
    for (auto i = start; i != end; i++) {
      insert(*i);
    }
  }

  // Merge a sorted, unique container into this set in O(a + b) instead of
  // O(b) memmoves. Small inputs use plain inserts to avoid allocation churn.
  void merge(const flat_set &other) { merge_sorted(other.contents); }

  void merge_sorted(const contents_type &values) {
    if (values.empty()) return;
    if (contents.empty()) {
      contents = values;
      return;
    }
    if (values.size() <= 8) {
      for (T value : values) insert(value);
      return;
    }
    contents_type merged;
    merged.reserve(contents.size() + values.size());
    std::set_union(contents.begin(), contents.end(), values.begin(), values.end(), std::back_inserter(merged));
    contents = std::move(merged);
  }

  // Remove every element of a sorted, unique container in O(a + b).
  void subtract_sorted(const contents_type &values) {
    if (contents.empty() || values.empty()) return;
    if (values.size() <= 8) {
      for (T value : values) erase(value);
      return;
    }
    contents_type remaining;
    remaining.reserve(contents.size());
    std::set_difference(contents.begin(), contents.end(), values.begin(), values.end(), std::back_inserter(remaining));
    contents = std::move(remaining);
  }

  // Adopt an already-sorted, unique vector without re-sorting.
  static flat_set from_sorted(contents_type &&values) {
    flat_set result;
    result.contents = std::move(values);
    return result;
  }

  iterator erase(const iterator &iter) {
    return contents.erase(iter);
  }

  void erase(T value) {
    auto end = this->end();
    auto iter = std::lower_bound(begin(), end, value);
    if (iter != end && *iter == value) {
      erase(iter);
    }
  }

  iterator begin() {
    return contents.begin();
  }

  const_iterator begin() const {
    return contents.begin();
  }

  iterator end() {
    return contents.end();
  }

  const_iterator end() const {
    return contents.end();
  }

  size_t count(T value) const {
    return std::binary_search(contents.begin(), contents.end(), value) ? 1 : 0;
  }

  size_t size() const {
    return contents.size();
  }
};

#endif // SUPERSTRING_FLAT_SET_H
