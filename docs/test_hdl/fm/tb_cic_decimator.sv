/* tb_cic_decimator.sv
 * CICフィルタ検証用のテストベンチ
 */

`timescale 1ns / 1ps
`include "cic_decimator.sv"

module tb_cic_decimator;
	/* パラメータ */
	localparam int N = 4;		//フィルタ段数
	localparam int R = 128;		//ダウンサンプリング間引き間隔
	localparam int M = 1;		//微分遅延
	localparam int IN_W = 16;	//入力ビット幅
	localparam int OUT_W = 25;	//出力ビット幅

	/* 信号 */
	logic clk;
	logic rst_n;
	logic signed [IN_W-1:0] in_data;
	logic in_data_valid;
	logic signed [OUT_W-1:0] out_data;
	logic out_data_valid;

	/* クロック生成 */
	initial begin
		clk = 0;
		forever #5 clk = ~clk; //周期10nsのクロック信号 = 100MHz
	end

	/* Device Under Test の接続 */
	cic_decimator #(
		.STAGES(N), .RATIO(R), .DELAY(M), .INPUT_WIDTH(IN_W), .OUTPUT_WIDTH(OUT_W)
	) dut (
		.clock(clk),
		.reset_n(rst_n),
		.input_data(in_data),
		.input_data_valid(in_data_valid),
		.output_data(out_data),
		.output_data_valid(out_data_valid)
	);

	/* 入力信号生成 */
	real pi = 3.1415926535;
	real frequency = 10000.0; //10kHzの正弦波を入力
	real sample_rate = 100000000.0; //100MS/s
	int t_step; //時間軸

	/* テスト */
	initial begin
		$dumpfile("tb_cic_decimator_10kHz.vcd");
        $dumpvars(0, tb_cic_decimator);
		/* 初期化 */
		rst_n = 1'b0;
		in_data = '0;
		in_data_valid = 1'b0;
		t_step = '0;

		/* リセット解除 */
		repeat (5) @(posedge clk); //リセット解除までに立ち上がりを5回待つ

		@(negedge clk); //リセット解除
		rst_n = 1'b1;

		repeat (100000) begin //10万クロック分 = 1ms検証
			@(negedge clk); //立ち下がりで信号生成 → 次の立ち上がりでDUTが信号取り込み → 次の立ち下がりで出力確認

			//input_data = '0; //ゼロ入力テスト
			//input_data = 1000; //DC入力テスト
			in_data = $rtoi((2**(IN_W-1)-1) * $cos(2.0 * pi * frequency * t_step / sample_rate)); //正弦波入力テスト
			in_data_valid = 1'b1;
			t_step = t_step + 1;
		end

		repeat ((N*M + N)*R) begin //フィルタの末尾応答とcomb段間パイプラインを流すためのゼロ入力
			@(negedge clk);
			in_data = '0;
			in_data_valid = 1'b1;
		end

		@(negedge clk); //最後の入力に対する応答を見る
		in_data_valid = 1'b0;

		repeat (4) @(negedge clk); //最後の入力に対するdecim_strobeなどの処理の待機

		$display("シミュレーション終了");
		$finish;
	end

	always @(negedge clk) begin
		if (rst_n && out_data_valid) begin
			//ゼロ入力テスト専用
			//assert (out_data === '0) else $fatal(1, "ゼロ入力テスト失敗: time=%0t, out=%0d", $time, out_data);

			$display("time=%0t, input=%0d, output=%0d", $time, in_data, out_data);
		end
	end
endmodule