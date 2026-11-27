module mux_4to1 (
    // データ入力（すべて4ビット）
    input  logic [3:0] A_data,  // Aレジスタからの値
    input  logic [3:0] B_data,  // Bレジスタからの値
    input  logic [3:0] IN_data, // 入力ポート（スイッチなど）からの値

    // 命令デコーダーからの選択信号（ワンホット：どれか1つだけがHIGHになる）
    input  logic       A_sel,
    input  logic       B_sel,
    input  logic       IN_sel,
    input  logic       Z_sel,

    // ALUへ送るデータ出力
    output logic [3:0] mux_out
    );

    always_comb begin
        // 優先順位をつけずに、選択信号に応じて出力を切り替える
        if (A_sel) begin
            mux_out = A_data;
        end else if (B_sel) begin
            mux_out = B_data;
        end else if (IN_sel) begin
            mux_out = IN_data;
        end else if (Z_sel) begin
            mux_out = 4'b0000;  // 0 + Im のための定数0
        end else begin
            mux_out = 4'b0000;  // 万が一、どの信号も立っていない場合の安全対策（ラッチ防止）
        end
    end

endmodule