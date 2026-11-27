module pc_4bit (
    input  logic       clk,      // クロック
    input  logic       rst_n,    // リセット（LOWで0番地へ）
    input  logic       pc_we,    // ジャンプ有効信号（HIGHでジャンプ実行）
    input  logic [3:0] Im,       // ジャンプ先のアドレス（即値）
    output logic [3:0] pc_out    // 現在のプログラムアドレス（ROMへ）
    );

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            pc_out <= 4'b0000;  // リセット時は0番地に戻る
        end else if (pc_we) begin
            pc_out <= Im;        // ジャンプ命令時は、即値のアドレスをロード
        end else begin
            pc_out <= pc_out + 4'b0001; // 通常時はカウントアップ (+1)
        end
    end

endmodule