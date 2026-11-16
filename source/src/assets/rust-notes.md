# Rust 学习笔记

对所有权与生命周期的阶段性整理。

## 1. 所有权

1. Rust 中每个值都有一个所有者
2. 同一时刻值只有一个所有者
3. 所有者离开作用域时，值被丢弃

```rust
fn main() {
    let s = String::from("hello");
    takes_ownership(s);
}
```

## 2. 借用与引用

- `&T` 不可变引用，可以同时存在多个
- `&mut T` 可变引用，同一时刻只能有一个

## 3. 下一步

- [ ] 读完 *The Rust Programming Language* 第 4 章
- [x] 给 rusqlite 封装一层连接池
- [ ] 理解 workspace 的 feature 合并语义
