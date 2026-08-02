#include "string_tools.h"

#include <ranges>

using namespace std;

std::vector<std::string_view> operator|(const std::string_view& s, const StringSplitParams& p)
{
    vector<string_view> res;
    string::size_type prevPos = 0, pos = 0;
    while ((pos = s.find(p.delimiter, pos)) != string::npos) {
        res.push_back(s.substr(prevPos, pos - prevPos));
        prevPos = ++pos;
    }
    res.push_back(s.substr(prevPos, pos - prevPos));
    return res;
}

int64_t operator|(const std::string& s, const ToNumberParams<int64_t>&) { return std::stoll(s); }
int operator|(const std::string& s, const ToNumberParams<int>&) { return std::stoi(s); }
unsigned long operator|(const std::string& s, const ToNumberParams<unsigned long>&) { return std::stoul(s); }

bool isSpaceOrNewLine(char ch) { return std::isspace(ch) || ch == '\n' || ch == '\r'; }

std::string operator|(const std::string& s, const AnsiToLowerParams& params)
{
    auto res = s;
    std::transform(s.begin(), s.end(), res.begin(), [](char c) { return (char)std::tolower(c); });
    return res;
}

std::string operator|(const std::string& s, const AnsiToUpperParams& params)
{
    auto res = s;
    std::transform(s.begin(), s.end(), res.begin(), [](char c) { return (char)std::toupper(c); });
    return res;
}

vector<string> splitToWords(const string& s)
{
    char prevCh = '\0';
    unsigned int start = 0;
    vector<string> words;

    auto takeWord = [&start, &s, &words](int i) {
        if (i - start <= 0)
            return;
        auto ss = s.substr(start, i - start);
        words.push_back(ss | ansiToLower());
    };

    // Any non-alphanumeric character is a word boundary (not just `_-. `), so identifiers built
    // from arbitrary OpenAPI names (header "x-next", path segment "pet/status", ...) split
    // correctly instead of leaking the punctuation into the resulting word.
    auto isDelimiter = [](char ch) { return !isalnum(static_cast<unsigned char>(ch)); };

    for (unsigned int i = 0; i < s.size(); i++) {
        char ch = s[i];
        bool splitNeeded = false;
        int skipChar = 0;
        if (islower(prevCh) && !islower(ch)) {
            splitNeeded = true;
        }

        while (isDelimiter(ch)) {
            splitNeeded = true;
            i++;
            skipChar++;
            if (i >= s.size())
                break;
            ch = s[i];
        }

        if (splitNeeded) {
            takeWord(i - skipChar);
            start = i;
        }
        prevCh = ch;
    }
    takeWord(s.size());
    return words;
}

string capitalize(const string& s)
{
    string res = s;
    if (!res.empty())
        res[0] = toupper(res[0]);
    return res;
}

string toPascalCase(const std::string& s)
{
    return splitToWords(s) | views::transform([](const auto& w) { return capitalize(w); }) | joinToString("");
}

string toSnakeCase(const std::string& s)
{
    return splitToWords(s) | views::transform([](const auto& w) { return w | ansiToLower(); }) | joinToString("_");
}

string toScreamingSnakeCase(const std::string& s)
{
    return splitToWords(s) | views::transform([](const auto& w) { return w | ansiToUpper(); }) | joinToString("_");
}

string toCamelCase(const std::string& s)
{
    bool first = true;
    return splitToWords(s) | views::transform([&](const auto& w) {
               if (first) {
                   first = false;
                   return w;
               } else {
                   return capitalize(w);
               }
           })
        | joinToString("");
}

bool isValidIdentifier(const string& s)
{
    if (s.empty())
        return false;
    if (!isalpha(static_cast<unsigned char>(s[0])) && s[0] != '_')
        return false;
    return all_of(s.begin() + 1, s.end(), [](char ch) { return isalnum(static_cast<unsigned char>(ch)) || ch == '_'; });
}

string sanitizeIdentifier(const string& s)
{
    string res;
    res.reserve(s.size());
    for (char ch : s) {
        res += (isalnum(static_cast<unsigned char>(ch)) || ch == '_') ? ch : '_';
    }
    if (res.empty() || isdigit(static_cast<unsigned char>(res[0])))
        res = "_" + res;
    return res;
}
