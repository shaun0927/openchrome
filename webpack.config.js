const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    'service-worker': './extension/src/service-worker.ts',
    'content-script': './extension/content/content-script.ts',
    'popup': './extension/popup/popup.ts',
  },
  output: {
    path: path.resolve(__dirname, 'dist/extension'),
    filename: '[name].js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'extension/manifest.json', to: 'manifest.json' },
        { from: 'extension/popup/popup.html', to: 'popup.html' },
        { from: 'extension/icons', to: 'icons', noErrorOnMissing: true },
      ],
    }),
  ],
  optimization: {
    minimize: false, // Keep readable for debugging
  },
  devtool: 'source-map',
};
