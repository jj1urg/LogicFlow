module alu (
    input  logic       clk,         // クロック（Cフラグ更新用）
    input  logic       rst_n,       // リセット（Cフラグ初期化用）
    input  logic [3:0] mux_out,     // マルチプレクサから選ばれたデータ (A, B, IN, 0 のいずれか)
    input  logic [3:0] Im,          // 命令からの即値
    
    output logic [3:0] alu_result,  // 演算結果（各レジスタやデータバスへ）
    output logic       carry_f      // 次の命令デコードに使うキャリーフラグ
    );

    // 内部信号：桁溢れ（キャリー）を捉えるために5ビットで計算する
    logic [4:0] sum_temp;
    logic       next_carry;

    // --- 1. 組み合わせ回路（足し算） ---
    always_comb begin
        // 4ビット同士の足し算を5ビットの信号に代入することで、最上位ビット（[4]）がキャリーになる
        sum_temp   = mux_out + Im;
        
        // 下位4ビットが実際の計算結果
        alu_result = sum_temp[3:0];
        
        // 最上位ビット（5ビット目）が1なら桁溢れ（キャリー発生）
        next_carry = sum_temp[4];
    end

    // --- 2. 順序回路（Cフラグの保持） ---
    // TD4のキャリーフラグは、計算があった次のクロック立ち上がりで更新されます
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            carry_f <= 1'b0; // リセットでフラグをクリア
        end else begin
            carry_f <= next_carry; // クロック同期でキャリー状態を保存
        end
    end

endmodule