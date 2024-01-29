module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    modulePathIgnorePatterns: ["<rootDir>/dist/"],
    transform: {
        "^.+\\.tsx?$": ["ts-jest", {
            tsconfig: 'test/tsconfig.json',
            isolatedModules: true,
        }],
    },
};
