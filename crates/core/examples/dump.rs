use std::io::Read;
fn main() {
    let mut md = String::new();
    std::io::stdin().read_to_string(&mut md).unwrap();
    for b in psymd_core::render::render(&md, &Default::default()).blocks {
        println!("[{}-{}] {}", b.line_start, b.line_end, b.html);
    }
}
