module rom_16x8bit (
    input  logic [3:0] address, // PCからのアドレス
    output logic [7:0] data     // デコーダーへ送る8ビットの命令
    );

    always_comb begin
        case (address)
            // 機械語の例（上位4bit: Opcode / 下位4bit: Im）
            4'h0: data = 8'b0000_0001; // ADD A, 1 (Aレジスタに1を足す)
            4'h1: data = 8'b1101_0000; // JEC 0   (キャリーフラグが1なら0番地へジャンプ)
            4'h2: data = 8'b1111_0000; // JMP 0   (0番地へ無条件ジャンプしてループ)
            // 残りのアドレス（デフォルトは安全のために 0000_0000: ADD A, 0 = 何もしない）
            default: data = 8'b0000_0000;
        endcase
    end

endmodule