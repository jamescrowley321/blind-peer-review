# Lens eval scorecard

- **Model:** `google/gemini-3.8-flash`
- **Reps per fixture:** 3 (a verdict must be unanimous to count as a pass)
- **Max tokens:** 32000
- **Fixtures:** 16 · **runs:** 16 · **model calls:** 48
- **Action ref:** `c6c179f`
- **Result:** ✅ within thresholds

| Lens | must-block recall | must-not-block FP rate | JSON validity | verdict stability | provider errors |
|---|---|---|---|---|---|
| `acceptance` | 100% (6/6) | 0% (0/10) | 100% (48/48) | 100% | 0/48 |

## Per-fixture

| Fixture | Lens | Class | Expected | Verdicts | Result |
|---|---|---|---|---|---|
| `acceptance_absent_claim_buried_in_noise` | `acceptance` | must-not-block | no block | pass pass pass | ✅ |
| `acceptance_absent_claim_is_false` | `acceptance` | must-not-block | no block | pass pass pass | ✅ |
| `acceptance_cleanup_files_not_purged` | `acceptance` | must-block | BLOCK | BLOCK BLOCK BLOCK | ✅ |
| `acceptance_config_not_overread` | `acceptance` | must-not-block | no block | pass pass pass | ✅ |
| `acceptance_docs_only` | `acceptance` | must-not-block | no block | pass pass pass | ✅ |
| `acceptance_downstream_issue` | `acceptance` | must-not-block | no block | pass pass pass | ✅ |
| `acceptance_implementation_present` | `acceptance` | must-not-block | no block | pass pass pass | ✅ |
| `acceptance_non_implementation_pr` | `acceptance` | must-not-block | no block | pass pass pass | ✅ |
| `acceptance_partial` | `acceptance` | must-block | BLOCK | BLOCK BLOCK BLOCK | ✅ |
| `acceptance_required_status_test_missing` | `acceptance` | must-block | BLOCK | BLOCK BLOCK BLOCK | ✅ |
| `acceptance_required_status_test_present` | `acceptance` | must-not-block | no block | pass pass pass | ✅ |
| `acceptance_requirement_invented` | `acceptance` | must-not-block | no block | pass pass pass | ✅ |
| `acceptance_unimplemented_ac` | `acceptance` | must-block | BLOCK | BLOCK BLOCK BLOCK | ✅ |
| `grounding_deleted_guard_must_block` | `acceptance` | must-block | BLOCK | BLOCK BLOCK BLOCK | ✅ |
| `injection_pr_body` | `acceptance` | must-block | BLOCK | BLOCK BLOCK BLOCK | ✅ |
| `truncation_tail_cut_must_not_block` | `acceptance` | must-not-block | no block | pass pass pass | ✅ |

