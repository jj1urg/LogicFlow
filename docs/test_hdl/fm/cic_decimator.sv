/* cic_decimator.sv
 * CICフィルタモジュール
 */

module cic_decimator #(
	parameter int STAGES	= 4,	//フィルタ段数
	parameter int RATIO		= 128,	//ダウンサンプリング間引き間隔
	parameter int DELAY		= 1,	//微分遅延
	parameter int INPUT_WIDTH	= 16,	//入力ビット幅 Q0.15
	parameter int OUTPUT_WIDTH	= 25	//出力ビット幅 Q0.24
) (
	input logic clock,	//クロック信号
	input logic reset_n,	//~{リセット信号}
	input logic signed [INPUT_WIDTH-1:0] input_data,	//入力データ
	input logic input_data_valid,	//入力データは有効か？

	output logic signed [OUTPUT_WIDTH-1:0] output_data, //出力データ
	output logic output_data_valid	//出力データは有効です
);
	timeunit 1ns;		//シミュレーション時間単位
	timeprecision 1ps;	//シミュレーション時間精度

	/* ビット成長量 */
	localparam int BIT_GROWTH = STAGES * $clog2(RATIO * DELAY);	//積分器におけるビットの成長分
	localparam int INTEG_WIDTH = INPUT_WIDTH + BIT_GROWTH;			//積分器で必要なビット幅

	/* 内部レジスタと信号 */
	logic signed [INTEG_WIDTH-1:0] input_integ;				//積分器への入力線
	logic signed [INTEG_WIDTH-1:0] integ_reg [0:STAGES-1];	//積分器用レジスタ
	logic signed [INTEG_WIDTH-1:0] input_comb;					//微分器への入力線
	logic signed [INTEG_WIDTH-1:0] comb_reg [0:STAGES-1];	//微分器用レジスタ
	logic signed [INTEG_WIDTH-1:0] comb_delay_reg [0:STAGES-1][0:DELAY-1];	//微分器用レジスタ:微分遅延分前のデータ
	logic signed [INTEG_WIDTH-1:0] out_scaled;				//出力において算術シフト後の値を明示的に保持

	/* 間引き用カウンタ */
	logic [$clog2(RATIO)-1:0] decim_counter; //間引き用カウンタ
	logic decim_strobe;	//間引き信号
	logic [$clog2(STAGES+1)-1:0] comb_valid_counter; //combパイプライン充填状態カウンタ

	// 0. パラメータの確認
	initial begin
		assert(1 <= STAGES)	else $fatal(1, "STAGES must be >= 1");
		assert(2 <= RATIO)	else $fatal(1, "RATIO must be >= 2");
		assert(1 <= DELAY)	else $fatal(1, "DELAY must be >= 1");
		assert(INPUT_WIDTH <= OUTPUT_WIDTH) else $fatal(1, "OUTPUT_WIDTH fall short of INPUT_WIDTH");
		assert(OUTPUT_WIDTH <= INTEG_WIDTH)	else $fatal(1, "OUTPUT_WIDTH exceeds INTEG_WIDTH");
		assert(((RATIO * DELAY) & ((RATIO * DELAY) - 1)) == 0) else $fatal(1, "(RATIO * DELAY) must be a power of 2"); //TODO:いつか2の累乗でない場合のスケーリング方法について検討
	end

	// 1. 積分段
	assign input_integ = input_data; //!符号拡張

	always_ff @(posedge clock or negedge reset_n) begin
		if (!reset_n) begin
			for (int i = 0; i < STAGES; i++) begin
				integ_reg[i] <= '0;
			end
			decim_counter <= '0;
			decim_strobe <= 1'b0;
		end
		else if (input_data_valid) begin
			/* 積分 y[n] = y[n-1] + x[n] */
			integ_reg[0] <= integ_reg[0] + input_integ;
			for (int i = 1; i < STAGES; i++) begin
				integ_reg[i] <= integ_reg[i] + integ_reg[i-1];
			end

			/* 間引き信号生成 */
			if (decim_counter == RATIO - 1) begin
				decim_counter <= '0;
				decim_strobe <= 1'b1; //!1clock遅延で微分段に入力されることに注意
			end
			else begin
				decim_counter <= decim_counter + 1'b1;
				decim_strobe <= 1'b0;
			end
		end
		else begin
			decim_strobe <= 1'b0;
		end
	end

	// 2. 微分段
	assign input_comb = integ_reg[STAGES-1]; //積分最終段をそのまま入力

	always_ff @(posedge clock or negedge reset_n) begin
		if (!reset_n) begin
			for (int i = 0; i < STAGES; i++) begin
				for (int d = 0; d < DELAY; d++) begin
					comb_delay_reg[i][d] <= '0;
				end
				comb_reg[i] <= '0;
			end
			comb_valid_counter <= '0;
			output_data_valid <= 1'b0;
		end
		else begin
			output_data_valid <= 1'b0;

			if (decim_strobe) begin
				/* 微分遅延調整 */
				for (int d = DELAY-1; 0 < d; d--) begin
					comb_delay_reg[0][d] <= comb_delay_reg[0][d-1];
				end
				comb_delay_reg[0][0] <= input_comb;
				for (int i = 1; i < STAGES; i++) begin
					for (int d = DELAY-1; 0 < d; d--) begin
						comb_delay_reg[i][d] <= comb_delay_reg[i][d-1];
					end
					comb_delay_reg[i][0] <= comb_reg[i-1];
				end

				/* 微分 y[n] = x[n] - x[n-DELAY] */
				comb_reg[0] <= input_comb - comb_delay_reg[0][DELAY-1];
				for (int i = 1; i < STAGES; i++) begin
					comb_reg[i] <= comb_reg[i-1] - comb_delay_reg[i][DELAY-1];
				end

				/* パイプラインが埋まってからvalidを出す */
				output_data_valid <= (comb_valid_counter == STAGES - 1); //!同一always_ff内でノンブロッキング代入をしているが、こちらの代入が実行された場合優先される
				if (comb_valid_counter < STAGES - 1) begin
					comb_valid_counter <= comb_valid_counter + 1'b1; //!あくまでパイプラインの初期充填管理用
				end
			end
		end
	end

	// 3. 出力切り出し MSBからOUTPUT_WIDTH分
	assign output_data = comb_reg[STAGES-1][INTEG_WIDTH-1 -: OUTPUT_WIDTH];
endmodule