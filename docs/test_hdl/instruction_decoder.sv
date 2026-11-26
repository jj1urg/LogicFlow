module instruction_decoder (
	input logic [7:0] instruction, //命令
	input logic carry_f, //キャリーフラグ
	output logic [3:0] Im, //即値
	output logic A_we, B_we, OUT_we, PC_we, //次回のクロックでデータバスの値を受け取るレジスタ有効信号
	output logic A_sel, B_sel, IN_sel, Z_sel, //マルチプレクサの選択信号
	output logic clk_stop //HALT用クロック停止信号
	);

	wire [3:0] opcode = instruction[7:4];
	assign Im = instruction[3:0];

	always_comb begin
		A_we = 1'b0;
		B_we = 1'b0;
		OUT_we = 1'b0;
		PC_we = 1'b0;
		A_sel = 1'b0;
		B_sel = 1'b0;
		IN_sel = 1'b0;
		Z_sel = 1'b0;
		clk_stop = 1'b0;

		if (opcode[3:2] == 2'b11) begin
			case (opcode[1:0])
				2'b00: clk_stop = 1'b1; //HALT
				2'b01: if (carry_f == 1'b1) PC_we = 1'b1; //JEC
				2'b10: if (carry_f == 1'b0) PC_we = 1'b1; //JNC
				2'b11: PC_we = 1'b1; //JMP
			endcase
		end else begin
			case (opcode[3:2])
				2'b00: A_we = 1'b1; //Aレジスタを更新
				2'b01: B_we = 1'b1; //Bレジスタを更新
				2'b10: OUT_we = 1'b1; //出力を更新
			endcase

			case (opcode[1:0])
				2'b00: A_sel = 1'b1; // A + Im
				2'b01: B_sel = 1'b1; // B + Im
				2'b10: IN_sel = 1'b1; // IN + Im
				2'b11: Z_sel = 1'b1; // 0 + Im
			endcase
		end
	end
endmodule
