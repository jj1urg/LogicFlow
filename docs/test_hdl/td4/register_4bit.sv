module register_4bit (
    input  logic       clk,      // クロック
    input  logic       rst_n,    // リセット（LOWで強制リセット）
    input  logic       we,       // ライトイネーブル（HIGHで書き込み）
    input  logic [3:0] data_in,  // 入力データ（データバスなどから）
    output logic [3:0] data_out  // 出力データ
    );

    // クロックの立ち上がり、またはリセットの立ち下がりで同期
    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            // RSTがLOWの時は、CLKやWEを完全に無視して即座に0
            data_out <= 4'b0000;
        end else if (we) begin
            // RSTがHIGH、かつWEがHIGHのときに、CLKの立ち上がりで値を保持
            data_out <= data_in;
        end
        // ※ weがLOWのときは、自動的に前回の出力を保持（ラッチではなくフリップフロップ）
    end
endmodule