fn main() {
    prost_build::compile_protos(&["proto/feishu_frame.proto"], &["proto/"])
        .expect("prost codegen failed");
}
