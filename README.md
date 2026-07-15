# benchmarks

Reproducible benchmarks backing the measurement claims in posts on
[usamaamjid.com/blog](https://www.usamaamjid.com/blog).

If a post here says a number, the script that produced it is in this repo. Run it
and check.

## mongodb-in-performance.mjs

Backs **[MongoDB $in Performance: The Array Size Isn't the Problem](https://www.usamaamjid.com/blog/mongodb-in-performance-large-objectid-arrays)**.

Measures how `$in` scales as the ObjectId array grows, against 500,000 documents
on a real `mongod` — plan choice, `keysExamined`, timings, chunking, and the BSON
ceiling.

```bash
git clone https://github.com/usamaamjid/benchmarks
cd benchmarks
npm install
npm run mongo:in
```

No MongoDB install needed. `mongodb-memory-server` downloads a real `mongod`
binary (~80MB, cached after the first run) and tears it down afterwards. A run
takes about a minute.

### Findings

```
=== $in on _id (primary index) ===
  IDs        ms    keysExam  docsExam  returned  plan
       10      1.6        11        10        10  FETCH ← IXSCAN
     1000     15.8      1001      1000      1000  FETCH ← IXSCAN
    10000     87.4     10001     10000     10000  FETCH ← IXSCAN
   100000    890.5    100001    100000    100000  FETCH ← IXSCAN
```

- `$in` never leaves the index, even at 100,000 values. It expands to one
  exact-match index bound per value — N point lookups, not a scan.
- `keysExamined` is exactly `n + 1` at every size. No wasted reads.
- Cost tracks **documents returned**, not array length. A 10-value `$in` and a
  10,000-value `$in` both returning 10,000 docs finish within 5% of each other —
  ~8.5 µs/doc either way.
- Chunking a big `$in` into batches is **slower** — same work, more round trips.
- The 16MB BSON ceiling needs ~800,000 ObjectIds. It is not your problem.

## Reading the numbers honestly

Timings come from a local `mongod` with a warm cache and no network, so they are
**relative, not production figures**. Each is the best of three attempts, and even
then the same query varies 10–30% between runs on one machine — and up to **2x
between machines**. The table above is one run on one laptop. You will get
different milliseconds.

These have **not** been run against Atlas or any hosted cluster, and the numbers
here should not be read as if they were. On Atlas every query also pays a network
round trip, large result sets are batched over the wire, shared tiers (M0/M2/M5)
throttle CPU, and a working set larger than RAM turns reads into page faults. Each
of those makes *documents returned* cost more, not less.

What doesn't vary between runs, machines, or hosting — and what the arguments
actually rest on — is the `explain()` output: plan choice, index bounds, and
`keysExamined`. Those are query planner decisions and they don't care how fast
your disk is.

If your `explain()` output differs from what's documented here, that's a real
finding — please open an issue.

The mongod version is **pinned** in each script. `mongodb-memory-server`'s default
drifts between releases, and a benchmark that silently changes engines isn't
reproducible.

## License

MIT
