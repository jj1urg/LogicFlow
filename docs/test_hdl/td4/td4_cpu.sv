module td4_cpu (
    input  logic       clk_in,   // 外部クロック
    input  logic       rst_n,    // 外部リセットスイッチ
    input  logic [3:0] IN_port,  // 入力ポート（4ビットスイッチ等）
    output logic [3:0] OUT_port  // 出力ポート（7セグ等へ）
    );

    // --- 内部配線（ワイヤー）の定義 ---
    logic [3:0] pc_addr;
    logic [7:0] instruction;
    logic [3:0] Im;

    // デコーダーからの制御信号
    logic A_we, B_we, OUT_we, PC_we;
    logic A_sel, B_sel, IN_sel, Z_sel;
    logic clk_stop;

    // データパスの信号
    logic [3:0] A_out, B_out;
    logic [3:0] mux_out;
    logic [3:0] alu_result;
    logic       carry_f;

    // --- HALT機能用：クロックのゲート制御 ---
    // clk_stopがHIGHになると、cpu_clkはLOWに固定されCPUが停止します
    wire cpu_clk = clk_in & ~clk_stop;

    // =========================================================
    // 各モジュールのインスタンス化（パーツの配置と配線）
    // =========================================================

    // 1. プログラムカウンタ
    pc_4bit pc_inst (
        .clk     (cpu_clk),
        .rst_n   (rst_n),
        .pc_we   (PC_we),
        .Im      (Im),
        .pc_out  (pc_addr)
    );

    // 2. プログラムメモリ (ROM)
    rom_16x8bit rom_inst (
        .address (pc_addr),
        .data    (instruction)
    );

    // 3. 命令デコーダー
    instruction_decoder decoder_inst (
        .instruction (instruction),
        .carry_f     (carry_f),
        .Im          (Im),
        .A_we        (A_we),
        .B_we        (B_we),
        .OUT_we      (OUT_we),
        .PC_we       (PC_we),
        .A_sel       (A_sel),
        .B_sel       (B_sel),
        .IN_sel      (IN_sel),
        .Z_sel       (Z_sel),
        .clk_stop    (clk_stop)
    );

    // 4. マルチプレクサ (セレクタ)
    mux_4to1 mux_inst (
        .A_data   (A_out),
        .B_data   (B_out),
        .IN_data  (IN_port),
        .A_sel    (A_sel),
        .B_sel    (B_sel),
        .IN_sel   (IN_sel),
        .Z_sel    (Z_sel),
        .mux_out  (mux_out)
    );

    // 5. ALU (加算器 + キャリーフラグ)
    alu alu_inst (
        .clk        (cpu_clk),
        .rst_n      (rst_n),
        .mux_out    (mux_out),
        .Im         (Im),
        .alu_result (alu_result),
        .carry_f    (carry_f)
    );

    // 6. Aレジスタ
    register_4bit reg_A (
        .clk      (cpu_clk),
        .rst_n    (rst_n),
        .we       (A_we),
        .data_in  (alu_result),
        .data_out (A_out)
    );

    // 7. Bレジスタ
    register_4bit reg_B (
        .clk      (cpu_clk),
        .rst_n    (rst_n),
        .we       (B_we),
        .data_in  (alu_result),
        .data_out (B_out)
    );

    // 8. OUTレジスタ
    register_4bit reg_OUT (
        .clk      (cpu_clk),
        .rst_n    (rst_n),
        .we       (OUT_we),
        .data_in  (alu_result),
        .data_out (OUT_port) // そのままCPU外部の出力ポートへ ← ここで論理合成エラー
    );

endmodule
