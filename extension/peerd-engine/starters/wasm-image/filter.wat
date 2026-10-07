;; Integer luminance and threshold kernels. No imports, memory, or host access.
(module
  (func (export "gray") (param $r i32) (param $g i32) (param $b i32) (result i32)
    (i32.shr_u (i32.add (i32.add (i32.mul (local.get $r) (i32.const 77))
                               (i32.mul (local.get $g) (i32.const 150)))
                      (i32.mul (local.get $b) (i32.const 29))) (i32.const 8)))
  (func (export "threshold") (param $gray i32) (param $level i32) (result i32)
    (select (i32.const 255) (i32.const 0) (i32.ge_u (local.get $gray) (local.get $level)))))
