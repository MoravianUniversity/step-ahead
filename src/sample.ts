export const SAMPLE_CODE = `def double(n):
    result = n * 2
    return result


def sum_to(n):
    total = 0
    i = 1
    while i <= n:
        total = total + i
        i = i + 1
    return total


def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)

def cat(x):
    return x + " meow"

a = double(3)
b = factorial(sum_to(2))
c = cat("meow")
print(a, b, cat(c))
`;
